import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/* Документы граждан Стамонийской Федерации.
   Личность подтверждается ником и ПИНом из банка — единый вход. */

const SALT = "stamonia-bank-salt";      // должен совпадать с bank.mjs
const KEY = "state";

const docStore = () => getStore({ name: "sf-docs", consistency: "strong" });
const bankStore = () => getStore({ name: "sf-bank", consistency: "strong" });
const hash = (pin) => crypto.createHash("sha256").update(SALT + pin).digest("hex");
const norm = (s) => String(s || "").trim().toLowerCase();
const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const bad = (m, c = 400) => new Response(JSON.stringify({ error: m }), { status: c, headers: { "content-type": "application/json" } });

function stamp() {
  const d = new Date(Date.now() + 3 * 3600 * 1000), p = (n) => String(n).padStart(2, "0");
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
}
function digits(seed, len) {
  const h = crypto.createHash("sha256").update("sf-doc-" + seed).digest("hex");
  let out = "";
  for (let i = 0; out.length < len; i++) out += parseInt(h[i], 16) % 10;
  return out;
}

async function loadDocs() {
  const raw = await docStore().get(KEY, { type: "json" });
  return raw || { people: {} };
}
const saveDocs = (s) => docStore().setJSON(KEY, s);

async function bankCard(nick) {
  const raw = await bankStore().get(KEY, { type: "json" });
  if (!raw || !raw.cards) return null;
  return raw.cards[norm(nick)] || null;
}
async function authOf(nick, pin) {
  const c = await bankCard(nick);
  if (!c) return { err: "Карты с таким ником нет. Сначала откройте счёт в банке." };
  if (c.pinHash !== hash(String(pin || ""))) return { err: "Неверный ПИН." };
  return { card: c };
}

function blank(nick) {
  return {
    nick, birthDate: "", birthPlace: "", city: "", job: "",
    verified: false, issued: stamp(), updatedAt: stamp(),
    license: { status: "none", number: "", until: "", issuedAt: "" }
  };
}
function pub(p, card) {
  return {
    nick: p.nick,
    birthDate: p.birthDate, birthPlace: p.birthPlace, city: p.city, job: p.job,
    verified: !!p.verified, issued: p.issued, updatedAt: p.updatedAt,
    passportNo: "СФ " + digits(p.nick, 6),
    taxNo: digits("tax" + p.nick, 10),
    license: p.license || { status: "none" },
    card: card ? { num: card.num, blocked: !!card.blocked, fines: (card.fines || []).filter((f) => !f.paid).length } : null
  };
}

async function notify(title, desc, fields, color) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Документы СФ", allowed_mentions: { parse: [] },
        embeds: [{ title, description: desc || "", color: color || 0x2e9b2c, fields: fields || [],
                   footer: { text: "Реестр граждан Стамонийской Федерации" }, timestamp: new Date().toISOString() }]
      })
    });
  } catch (_) { }
}

export default async (req) => {
  if (req.method !== "POST") return bad("Только POST", 405);
  let body; try { body = await req.json(); } catch { return bad("Битый запрос"); }
  const a = body.action;
  const state = await loadDocs();
  const CODE = process.env.TREASURER_CODE || "";
  const isAdmin = () => CODE && String(body.code || "") === CODE;

  if (a === "login") {
    const r = await authOf(body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    const k = norm(r.card.nick);
    if (!state.people[k]) { state.people[k] = blank(r.card.nick); await saveDocs(state); }
    return ok({ doc: pub(state.people[k], r.card) });
  }

  if (a === "save") {
    const r = await authOf(body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    const k = norm(r.card.nick);
    const p = state.people[k] || blank(r.card.nick);
    const cut = (v, n) => String(v || "").trim().slice(0, n);
    const bd = cut(body.birthDate, 10);
    if (bd && !/^\d{2}\.\d{2}\.\d{4}$/.test(bd)) return bad("Дата рождения в формате ДД.ММ.ГГГГ.");
    const changed = p.birthDate !== bd || p.birthPlace !== cut(body.birthPlace, 40) || p.city !== cut(body.city, 40);
    p.birthDate = bd;
    p.birthPlace = cut(body.birthPlace, 40);
    p.city = cut(body.city, 40);
    p.job = cut(body.job, 40);
    p.updatedAt = stamp();
    if (changed) p.verified = false;
    state.people[k] = p;
    await saveDocs(state);
    if (changed) {
      await notify("Анкета на проверку", null, [
        { name: "Гражданин", value: p.nick, inline: true },
        { name: "Город", value: p.city || "не указан", inline: true },
        { name: "Место рождения", value: p.birthPlace || "не указано", inline: true }
      ], 0xe3c35a);
    }
    return ok({ doc: pub(p, r.card), note: changed ? "Сохранено. Паспорт ушёл на проверку." : "Сохранено." });
  }

  if (a === "admin_list") {
    if (!isAdmin()) return bad("Неверный код.", 401);
    const rows = Object.values(state.people).map((p) => ({
      nick: p.nick, city: p.city, birthPlace: p.birthPlace, birthDate: p.birthDate,
      verified: !!p.verified, updatedAt: p.updatedAt,
      license: p.license || { status: "none" }, passportNo: "СФ " + digits(p.nick, 6)
    })).sort((x, y) => (x.verified === y.verified ? x.nick.localeCompare(y.nick) : x.verified ? 1 : -1));
    return ok({ people: rows });
  }

  if (a === "admin_verify") {
    if (!isAdmin()) return bad("Неверный код.", 401);
    const p = state.people[norm(body.nick)];
    if (!p) return bad("Гражданин не найден.");
    p.verified = !p.verified;
    p.updatedAt = stamp();
    await saveDocs(state);
    await notify(p.verified ? "Паспорт подтверждён" : "Подтверждение снято", null,
      [{ name: "Гражданин", value: p.nick, inline: true }, { name: "Город", value: p.city || "—", inline: true }],
      p.verified ? 0x2e9b2c : 0xff6b5e);
    return ok({ note: p.verified ? "Паспорт " + p.nick + " подтверждён." : "Подтверждение снято." });
  }

  if (a === "admin_license") {
    if (!isAdmin()) return bad("Неверный код.", 401);
    const p = state.people[norm(body.nick)];
    if (!p) return bad("Гражданин не найден.");
    const st = ["none", "active", "revoked"].includes(body.status) ? body.status : "none";
    p.license = {
      status: st,
      number: st === "active" ? "ЛО-" + digits("gun" + p.nick, 5) : "",
      until: String(body.until || "").slice(0, 10),
      issuedAt: st === "active" ? stamp() : ""
    };
    p.updatedAt = stamp();
    await saveDocs(state);
    const label = st === "active" ? "Лицензия выдана" : st === "revoked" ? "Лицензия отозвана" : "Лицензии нет";
    await notify(label, "Оружие TACZ · ст. 6 кодекса", [
      { name: "Гражданин", value: p.nick, inline: true },
      { name: "Номер", value: p.license.number || "—", inline: true },
      { name: "Действует до", value: p.license.until || "бессрочно", inline: true }
    ], st === "active" ? 0x2e9b2c : 0xff6b5e);
    return ok({ note: label + " · " + p.nick });
  }

  if (a === "admin_delete") {
    if (!isAdmin()) return bad("Неверный код.", 401);
    const k = norm(body.nick);
    if (!state.people[k]) return bad("Гражданин не найден.");
    const nick = state.people[k].nick;
    delete state.people[k];
    await saveDocs(state);
    return ok({ note: "Анкета " + nick + " удалена." });
  }

  return bad("Неизвестное действие.");
};

export const config = { path: "/api/docs" };
