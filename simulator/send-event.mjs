// simulator/send-event.mjs
//
// 无硬件测试用：构造 Ring webhook 事件，用同样的 HMAC-SHA256 逻辑签名，
// POST 到本地/远端的 ring-webhook 函数，验证整条链路（验签→解析→入库）。
//
// 用法：
//   RING_HMAC_KEY=<key> node simulator/send-event.mjs \
//     --url http://localhost:54321/functions/v1/ring-webhook \
//     --type motion_detected --device doorbell-1 --sub-type human

import { createHmac, randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const url = args.url;
const hmacKey = process.env.RING_HMAC_KEY;
if (!url || !hmacKey) {
  console.error("need --url and RING_HMAC_KEY env");
  process.exit(1);
}

const type = args.type ?? "motion_detected";
const deviceId = args.device ?? "sim-doorbell-1";

// JSON:API 风格的模拟负载（字段名按官方文档的事件结构）
const payload = {
  data: {
    id: randomUUID(),
    type,
    attributes: {
      device_id: deviceId,
      sub_type: args["sub-type"] ?? (type === "motion_detected" ? "human" : undefined),
      occurred_at: new Date().toISOString(),
    },
  },
};

const rawBody = JSON.stringify(payload);
const keyBuf = /^[0-9a-fA-F]+$/.test(hmacKey) && hmacKey.length % 2 === 0 && hmacKey.length >= 32
  ? Buffer.from(hmacKey, "hex")
  : Buffer.from(hmacKey, "utf8");
const signature = createHmac("sha256", keyBuf).update(rawBody).digest("hex");

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Signature": signature },
  body: rawBody,
});
console.log("status:", res.status);
console.log("body:", await res.text());
