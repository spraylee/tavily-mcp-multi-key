export type KeyStatus = "active" | "cooldown" | "exhausted" | "invalid";

export interface KeyProbeResult {
  status: "active" | "cooldown" | "exhausted" | "invalid" | "unknown";
  remaining?: number | null;
  cooldownMs?: number;
}

export interface KeyStatusSnapshot {
  index: number;
  key: string;
  status: KeyStatus;
  remaining?: number | null;
  availableAt?: number;
}

interface KeyRecord {
  key: string;
  configuredOrder: number;
  status: KeyStatus;
  remaining?: number | null;
  availableAt?: number;
}

const DEFAULT_COOLDOWN_MS = 30_000;

/** Mask a key for logging/display: keep prefix and last 4 chars. */
export function maskKey(key: string): string {
  if (key.length <= 8) {
    return `${key.slice(0, 2)}****`;
  }
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export class KeyPool {
  private readonly records: KeyRecord[];
  private lastProbeAt = 0;

  constructor(keys: string[], private readonly cooldownMs = DEFAULT_COOLDOWN_MS) {
    this.records = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].map((key, index) => ({
      key,
      configuredOrder: index,
      status: "active",
    }));
  }

  get size(): number {
    return this.records.length;
  }

  /** Timestamp (ms epoch) of the last completed probe(); 0 if never probed. */
  get lastProbedAt(): number {
    return this.lastProbeAt;
  }

  /** Milliseconds since the last completed probe(); Infinity if never. */
  get lastProbeAgoMs(): number {
    return this.lastProbeAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastProbeAt;
  }

  /** Probe every key's usage and refresh ordering. Exposed for status tooling. */
  async probe(probeKey: (key: string) => Promise<KeyProbeResult>): Promise<void> {
    await Promise.all(
      this.records.map(async (record) => {
        try {
          this.applyProbe(record, await probeKey(record.key));
        } catch {
          // Network-level failure to reach /usage says nothing about the key.
          // Fresh key: stays active (lazy discovery via real requests).
          // Previously-sorted pool: state preserved, no reshuffle.
          record.status = record.status === "cooldown" || record.status === "exhausted" || record.status === "invalid" ? record.status : "active";
          record.availableAt = record.status === "cooldown" ? record.availableAt : undefined;
        }
      }),
    );

    // Sort by remaining credits (desc). Probe failures leave remaining
    // untouched (undefined = never learned), so a flaky probe does not
    // reshuffle a previously-sorted pool.
    this.records.sort((left, right) => {
      const remainingDifference = this.remainingRank(right) - this.remainingRank(left);
      return remainingDifference || left.configuredOrder - right.configuredOrder;
    });

    this.lastProbeAt = Date.now();
  }

  nextKey(): string | undefined {
    const now = Date.now();

    for (const record of this.records) {
      if (!this.isAvailable(record, now)) {
        continue;
      }

      return record.key;
    }

    return undefined;
  }

  markSuccess(key: string): void {
    const record = this.find(key);
    if (!record) {
      return;
    }

    record.status = "active";
    record.availableAt = undefined;
  }

  markFailure(key: string, status: number | undefined, retryAfterMs?: number): void {
    const record = this.find(key);
    if (!record) {
      return;
    }

    if (status === 401) {
      record.status = "invalid";
      record.availableAt = undefined;
      return;
    }

    if (status === 432 || status === 433) {
      // Exhausted for now, but the monthly quota resets on the 1st of each
      // month. A later probe() can flip this back to active — keep remaining=0
      // so the sort still deprioritizes it until then.
      record.status = "exhausted";
      record.availableAt = undefined;
      record.remaining = 0;
      return;
    }

    if (status === 429) {
      record.status = "cooldown";
      record.availableAt = Date.now() + Math.max(retryAfterMs ?? this.cooldownMs, 0);
    }
  }

  snapshots(): KeyStatusSnapshot[] {
    return this.records.map((record, index) => ({
      index: index + 1,
      key: maskKey(record.key),
      status: this.currentStatus(record),
      ...(record.remaining === undefined ? {} : { remaining: record.remaining }),
      ...(record.availableAt === undefined ? {} : { availableAt: record.availableAt }),
    }));
  }

  unavailableMessage(): string {
    const details = this.snapshots()
      .map((snapshot) => {
        const remaining = snapshot.remaining === undefined ? "" : `, remaining=${snapshot.remaining}`;
        return `#${snapshot.index} ${snapshot.status}${remaining}`;
      })
      .join("; ");

    return details
      ? `No available Tavily API keys. Key status: ${details}`
      : "No Tavily API keys configured.";
  }

  private applyProbe(record: KeyRecord, result: KeyProbeResult): void {
    if (result.status === "unknown") {
      record.status = "active";
      record.availableAt = undefined;
      return;
    }

    record.status = result.status;
    record.remaining = result.remaining;
    record.availableAt = result.status === "cooldown"
      ? Date.now() + Math.max(result.cooldownMs ?? this.cooldownMs, 0)
      : undefined;
  }

  private remainingRank(record: KeyRecord): number {
    if (record.remaining === null) {
      return Number.POSITIVE_INFINITY;
    }

    return record.remaining ?? Number.NEGATIVE_INFINITY;
  }

  private currentStatus(record: KeyRecord): KeyStatus {
    if (record.status === "cooldown" && record.availableAt !== undefined && record.availableAt <= Date.now()) {
      record.status = "active";
      record.availableAt = undefined;
    }

    return record.status;
  }

  private isAvailable(record: KeyRecord, now: number): boolean {
    if (record.status === "active") {
      return true;
    }

    if (record.status === "cooldown" && record.availableAt !== undefined && record.availableAt <= now) {
      record.status = "active";
      record.availableAt = undefined;
      return true;
    }

    return false;
  }

  private find(key: string): KeyRecord | undefined {
    return this.records.find((record) => record.key === key);
  }
}
