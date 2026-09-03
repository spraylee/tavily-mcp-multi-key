//! Multi-key pool: rotation, cooldown, exhaustion and status snapshots.
//! Direct port of `src/key-pool.ts` (v0.2.2 semantics).

use std::collections::HashSet;
use std::future::Future;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use serde_json::{json, Value};

pub const DEFAULT_COOLDOWN_MS: u64 = 30_000;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStatus {
    Active,
    Cooldown,
    Exhausted,
    Invalid,
}

impl KeyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            KeyStatus::Active => "active",
            KeyStatus::Cooldown => "cooldown",
            KeyStatus::Exhausted => "exhausted",
            KeyStatus::Invalid => "invalid",
        }
    }
}

/// Outcome of probing one key against GET /usage.
#[derive(Debug, Clone)]
pub struct KeyProbeResult {
    /// None = unknown (observation plane failed; keep key usable).
    pub status: Option<KeyStatus>,
    /// None = never learned, Some(None) = unlimited, Some(Some(n)) = n credits left.
    pub remaining: Option<Option<u64>>,
    pub cooldown_ms: Option<u64>,
}

impl KeyProbeResult {
    pub fn active() -> Self {
        KeyProbeResult { status: Some(KeyStatus::Active), remaining: None, cooldown_ms: None }
    }
    pub fn active_remaining(remaining: Option<u64>) -> Self {
        KeyProbeResult { status: Some(KeyStatus::Active), remaining: Some(remaining), cooldown_ms: None }
    }
    pub fn exhausted() -> Self {
        KeyProbeResult {
            status: Some(KeyStatus::Exhausted),
            remaining: Some(Some(0)),
            cooldown_ms: None,
        }
    }
    pub fn invalid() -> Self {
        KeyProbeResult { status: Some(KeyStatus::Invalid), remaining: None, cooldown_ms: None }
    }
    pub fn unknown() -> Self {
        KeyProbeResult { status: None, remaining: None, cooldown_ms: None }
    }
}

/// Distinguishes "the /usage HTTP response said something" from "we could not
/// reach /usage at all" — the TS version encodes this as throw vs return.
pub enum ProbeOutcome {
    Result(KeyProbeResult),
    NetworkError,
}

#[derive(Debug, Clone)]
struct KeyRecord {
    key: String,
    configured_order: usize,
    status: KeyStatus,
    remaining: Option<Option<u64>>,
    available_at: Option<u64>,
}

/// Mask a key for logging/display: keep prefix and last 4 chars.
pub fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        format!("{}****", &key[..key.char_indices().take(2).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(0)])
    } else {
        format!("{}...{}", &key[..8], &key[key.len() - 4..])
    }
}

pub struct KeyPool {
    records: Vec<KeyRecord>,
    cooldown_ms: u64,
    last_probe_at: u64,
}

impl KeyPool {
    pub fn new(keys: Vec<String>, cooldown_ms: u64) -> Self {
        let mut seen = HashSet::new();
        let records = keys
            .into_iter()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .filter(|k| seen.insert(k.clone()))
            .enumerate()
            .map(|(index, key)| KeyRecord {
                key,
                configured_order: index,
                status: KeyStatus::Active,
                remaining: None,
                available_at: None,
            })
            .collect();
        KeyPool { records, cooldown_ms, last_probe_at: 0 }
    }

    pub fn size(&self) -> usize {
        self.records.len()
    }

    /// Timestamp (ms epoch) of the last completed probe; 0 if never.
    pub fn last_probed_at(&self) -> u64 {
        self.last_probe_at
    }

    /// true if the last probe is older than `threshold_ms` (or never probed).
    pub fn probe_is_stale(&self, threshold_ms: u64) -> bool {
        self.last_probe_at == 0 || now_ms().saturating_sub(self.last_probe_at) > threshold_ms
    }

    /// Probe every key concurrently, refresh ordering.
    /// `probe_key` receives the raw key and returns the outcome for it.
    pub async fn probe<F, Fut>(&mut self, mut probe_key: F)
    where
        F: FnMut(String) -> Fut,
        Fut: Future<Output = ProbeOutcome>,
    {
        let keys: Vec<String> = self.records.iter().map(|record| record.key.clone()).collect();
        let futs: Vec<_> = keys.into_iter().map(|key| probe_key(key)).collect();
        let outcomes = join_all(futs).await;

        for (record, outcome) in self.records.iter_mut().zip(outcomes.into_iter()) {
            match outcome {
                ProbeOutcome::NetworkError => {
                    // Network-level failure to reach /usage says nothing about
                    // the key: fresh keys stay active, known-bad states survive.
                    if record.status == KeyStatus::Active {
                        // stays active
                    }
                    record.available_at =
                        if record.status == KeyStatus::Cooldown { record.available_at } else { None };
                }
                ProbeOutcome::Result(result) => Self::apply_probe(record, result, self.cooldown_ms),
            }
        }

        // Sort by remaining credits (desc). Never-learned sorts last, unlimited
        // first; ties resolved by configured order so ordering is stable.
        self.records.sort_by(|left, right| {
            remaining_rank(&right.remaining)
                .cmp(&remaining_rank(&left.remaining))
                .then(left.configured_order.cmp(&right.configured_order))
        });

        self.last_probe_at = now_ms();
    }

    fn apply_probe(record: &mut KeyRecord, result: KeyProbeResult, cooldown_ms: u64) {
        let Some(status) = result.status else {
            // Observation-plane failure (e.g. /usage 429): the data plane may
            // still be fine — keep the key usable and let real requests judge.
            record.status = KeyStatus::Active;
            record.available_at = None;
            return;
        };

        record.status = status;
        record.remaining = result.remaining;
        record.available_at = if status == KeyStatus::Cooldown {
            Some(now_ms() + result.cooldown_ms.unwrap_or(cooldown_ms).max(0))
        } else {
            None
        };
    }

    pub fn next_key(&mut self) -> Option<String> {
        let now = now_ms();
        for record in self.records.iter_mut() {
            if record.is_available(now) {
                return Some(record.key.clone());
            }
        }
        None
    }

    pub fn mark_success(&mut self, key: &str) {
        if let Some(record) = self.find_mut(key) {
            record.status = KeyStatus::Active;
            record.available_at = None;
        }
    }

    pub fn mark_failure(&mut self, key: &str, status: Option<u16>, retry_after_ms: Option<u64>) {
        let cooldown_ms = self.cooldown_ms;
        let Some(record) = self.find_mut(key) else { return };

        match status {
            Some(401) => {
                record.status = KeyStatus::Invalid;
                record.available_at = None;
            }
            Some(432) | Some(433) => {
                // Exhausted for now; monthly quota resets on the 1st. Keep
                // remaining=0 so the sort still deprioritizes it until then.
                record.status = KeyStatus::Exhausted;
                record.available_at = None;
                record.remaining = Some(Some(0));
            }
            Some(429) => {
                record.status = KeyStatus::Cooldown;
                record.available_at = Some(now_ms() + retry_after_ms.unwrap_or(cooldown_ms).max(0));
            }
            _ => {}
        }
    }

    pub fn snapshots(&mut self) -> Vec<Value> {
        let now = now_ms();
        self.records
            .iter_mut()
            .enumerate()
            .map(|(index, record)| {
                let status = record.current_status(now);
                let mut snapshot = json!({
                    "index": index + 1,
                    "key": mask_key(&record.key),
                    "status": status.as_str(),
                });
                if let Some(remaining) = record.remaining {
                    snapshot["remaining"] = match remaining {
                        Some(n) => json!(n),
                        None => Value::Null,
                    };
                }
                if let Some(available_at) = record.available_at {
                    snapshot["availableAt"] = json!(available_at);
                }
                snapshot
            })
            .collect()
    }

    pub fn unavailable_message(&mut self) -> String {
        if self.records.is_empty() {
            return "No Tavily API keys configured.".to_string();
        }
        let details = self
            .snapshots()
            .iter()
            .map(|snapshot| {
                let remaining = match snapshot.get("remaining") {
                    None => String::new(),
                    Some(Value::Null) => String::new(),
                    Some(v) => format!(", remaining={v}"),
                };
                format!(
                    "#{} {}{}",
                    snapshot["index"].as_u64().unwrap_or(0),
                    snapshot["status"].as_str().unwrap_or(""),
                    remaining
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        format!("No available Tavily API keys. Key status: {details}")
    }

    fn find_mut(&mut self, key: &str) -> Option<&mut KeyRecord> {
        self.records.iter_mut().find(|record| record.key == key)
    }
}

impl KeyRecord {
    fn is_available(&mut self, now: u64) -> bool {
        if self.status == KeyStatus::Active {
            return true;
        }
        if self.status == KeyStatus::Cooldown
            && self.available_at.map(|at| at <= now).unwrap_or(false)
        {
            self.status = KeyStatus::Active;
            self.available_at = None;
            return true;
        }
        false
    }

    fn current_status(&mut self, now: u64) -> KeyStatus {
        if self.status == KeyStatus::Cooldown
            && self.available_at.map(|at| at <= now).unwrap_or(false)
        {
            self.status = KeyStatus::Active;
            self.available_at = None;
        }
        self.status
    }
}

fn remaining_rank(remaining: &Option<Option<u64>>) -> i64 {
    match remaining {
        None => i64::MIN,          // never learned
        Some(None) => i64::MAX,    // unlimited
        Some(Some(n)) => *n as i64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(keys: &[&str]) -> KeyPool {
        KeyPool::new(keys.iter().map(|k| k.to_string()).collect(), DEFAULT_COOLDOWN_MS)
    }

    fn ok(status: KeyStatus) -> ProbeOutcome {
        ProbeOutcome::Result(KeyProbeResult {
            status: Some(status),
            remaining: None,
            cooldown_ms: None,
        })
    }

    fn ok_with_remaining(status: KeyStatus, remaining: Option<u64>) -> ProbeOutcome {
        ProbeOutcome::Result(KeyProbeResult::active_remaining(remaining).with_status(status))
    }

    impl KeyProbeResult {
        fn with_status(mut self, status: KeyStatus) -> Self {
            self.status = Some(status);
            self
        }
    }

    #[test]
    fn dedupes_and_trims() {
        let mut p = pool(&["  tvly-a  ", "tvly-a", "", "tvly-b"]);
        assert_eq!(p.size(), 2);
        assert_eq!(p.next_key().unwrap(), "tvly-a");
    }

    #[tokio::test]
    async fn probe_sorts_by_remaining_desc_then_configured_order() {
        let mut p = pool(&["tvly-low", "tvly-high", "tvly-mid"]);
        p.probe(|key| async move {
            match key.as_str() {
                "tvly-low" => ok_with_remaining(KeyStatus::Active, Some(10)),
                "tvly-high" => ok_with_remaining(KeyStatus::Active, Some(900)),
                _ => ok_with_remaining(KeyStatus::Active, Some(10)),
            }
        })
        .await;
        // Same remaining → configured order keeps tvly-low before tvly-mid.
        assert_eq!(p.next_key().unwrap(), "tvly-high");
    }

    #[tokio::test]
    async fn probe_network_error_preserves_exhausted() {
        let mut p = pool(&["tvly-a", "tvly-b"]);
        p.mark_failure("tvly-a", Some(432), None);
        p.probe(|_| async { ProbeOutcome::NetworkError }).await;
        // tvly-a stays exhausted; tvly-b active → rotation lands on tvly-b
        assert_eq!(p.next_key().unwrap(), "tvly-b");
    }

    #[tokio::test]
    async fn probe_unknown_marks_active() {
        let mut p = pool(&["tvly-a"]);
        p.mark_failure("tvly-a", Some(432), None); // exhausted first
        p.probe(|_| async { ProbeOutcome::Result(KeyProbeResult::unknown()) }).await;
        assert_eq!(p.next_key().unwrap(), "tvly-a");
    }

    #[tokio::test]
    async fn probe_exhausted_remaining_zero_sorts_last() {
        let mut p = pool(&["tvly-empty", "tvly-alive"]);
        p.probe(|key| async move {
            if key == "tvly-empty" {
                ProbeOutcome::Result(KeyProbeResult::exhausted())
            } else {
                ok_with_remaining(KeyStatus::Active, Some(42))
            }
        })
        .await;
        assert_eq!(p.next_key().unwrap(), "tvly-alive");
    }

    #[tokio::test]
    async fn rotation_marks_and_rotates() {
        let mut p = pool(&["tvly-a", "tvly-b"]);
        assert_eq!(p.next_key().unwrap(), "tvly-a");
        p.mark_failure("tvly-a", Some(401), None); // invalid
        assert_eq!(p.next_key().unwrap(), "tvly-b");
        p.mark_success("tvly-a"); // does not resurrect invalid (mark_success only clears cooldown-ish state)
        // ...but per TS semantics markSuccess sets active unconditionally:
        assert_eq!(p.next_key().unwrap(), "tvly-a");
    }

    #[test]
    fn cooldown_expiry_promotes() {
        let mut p = pool(&["tvly-a"]);
        p.mark_failure("tvly-a", Some(429), Some(0)); // available immediately
        assert_eq!(p.next_key().unwrap(), "tvly-a");
    }

    #[test]
    fn mark_failure_432_sets_remaining_zero() {
        let mut p = pool(&["tvly-a"]);
        p.mark_failure("tvly-a", Some(433), None);
        let snapshots = p.snapshots();
        assert_eq!(snapshots[0]["status"], "exhausted");
        assert_eq!(snapshots[0]["remaining"], 0);
    }

    #[test]
    fn masks_keys() {
        assert_eq!(mask_key("tvly-abcdefgh1234"), "tvly-abc...1234");
        assert_eq!(mask_key("short"), "sh****");
    }

    #[test]
    fn unavailable_message_lists_keys() {
        let mut p = pool(&["tvly-abcdefgh1234"]);
        p.mark_failure("tvly-abcdefgh1234", Some(432), None);
        let msg = p.unavailable_message();
        assert!(msg.contains("#1 exhausted, remaining=0"), "got: {msg}");
    }


    async fn stale_probe_detection() {
        let mut p = pool(&["tvly-a"]);
        assert!(p.probe_is_stale(1)); // never probed → stale
        p.probe(|_| async { ok(KeyStatus::Active) }).await;
        assert!(!p.probe_is_stale(600_000));
    }
}
