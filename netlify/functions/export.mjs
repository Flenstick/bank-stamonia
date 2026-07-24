import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const KEY = "state";
const norm = (s) => String(s || "").trim().toLowerCase();
const photoKey = (nick) => "photo-" + crypto.createHash("sha1").update(norm(nick)).digest("hex");

export default async (req) => {
  const code = new URL(req.url).searchParams.get("code") || "";
  const CODE = process.env.TREASURER_CODE || "";
  if (!CODE || code !== CODE) {
    return new Response(JSON.stringify({ error: "Неверный код казначея." }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  }

  const bankStore = getStore({ name: "sf-bank", consistency: "strong" });
  const docsStore = getStore({ name: "sf-docs", consistency: "strong" });

  const bank = (await bankStore.get(KEY, { type: "json" })) || { cards: {}, seq: 0 };
  const docs = (await docsStore.get(KEY, { type: "json" })) || { people: {} };

  const photos = {};
  for (const c of Object.values(bank.cards || {})) {
    if (!c.face || !c.face.photo) continue;
    try {
      const p = await bankStore.get(photoKey(c.nick));
      if (p) photos[photoKey(c.nick)] = p;
    } catch (_) {}
  }

  const dump = { exportedAt: new Date().toISOString(), bank, docs, photos };
  return new Response(JSON.stringify(dump), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="bank-dump.json"'
    }
  });
};

export const config = { path: "/api/export" };
