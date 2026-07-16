import assert from "node:assert/strict";
import test from "node:test";
import { KeyPool } from "../build/key-pool.js";

test("预检会排除已耗尽的 Key，并优先使用剩余额度更多的 Key", async () => {
  const keyPool = new KeyPool(["key-a", "key-b", "key-c"]);

  await keyPool.probe(async (apiKey) => {
    if (apiKey === "key-a") {
      return { status: "exhausted", remaining: 0 };
    }
    return { status: "active", remaining: apiKey === "key-b" ? 200 : 100 };
  });

  assert.deepEqual(
    keyPool.snapshots().map((snapshot) => snapshot.status),
    ["active", "active", "exhausted"],
  );
  assert.equal(keyPool.nextKey(), "key-b");
  assert.equal(keyPool.nextKey(), "key-b");
  keyPool.markFailure("key-b", 432);
  assert.equal(keyPool.nextKey(), "key-c");
});

test("432 会永久跳过 Key，429 只进入冷却状态", () => {
  const keyPool = new KeyPool(["key-a", "key-b"], 30_000);

  keyPool.markFailure("key-a", 432);
  assert.equal(keyPool.nextKey(), "key-b");
  assert.equal(keyPool.snapshots()[0].status, "exhausted");

  keyPool.markFailure("key-b", 429, 0);
  assert.equal(keyPool.nextKey(), "key-b");
  assert.equal(keyPool.snapshots()[1].status, "active");
});
