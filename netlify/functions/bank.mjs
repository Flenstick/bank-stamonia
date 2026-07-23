import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/* ————— настройки ————— */
const RATE = 8;                                   // 1 МОН = 8 Алтын
const SALT = "stamonia-bank-salt";                // соль для ПИНов
const KEY = "state";

const store = () => getStore({ name: "sf-bank", consistency: "strong" });
const hash = (pin) => crypto.createHash("sha256").update(SALT + pin).digest("hex");
const norm = (s) => String(s || "").trim().toLowerCase();
const money = (n) => Number(n).toLocaleString("ru-RU");
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const bad = (msg, code = 400) => new Response(JSON.stringify({ error: msg }), { status: code, headers: { "content-type": "application/json" } });

function stamp() {
  const d = new Date(Date.now() + 3 * 3600 * 1000); // UTC+3
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function load() {
  const raw = await store().get(KEY, { type: "json" });
  return raw || { cards: {}, seq: 0 };
}
const persist = (state) => store().setJSON(KEY, state);

function cardNumber(state) {
  let n;
  do {
    n = "СФ " + (1000 + Math.floor(Math.random() * 9000)) + " " + (1000 + Math.floor(Math.random() * 9000));
  } while (Object.values(state.cards).some((c) => c.num === n));
  return n;
}
function find(state, q) {
  const s = norm(q).replace(/\s+/g, " ");
  if (state.cards[s]) return state.cards[s];
  return Object.values(state.cards).find((c) => norm(c.num) === s) || null;
}
function pub(c) {
  return { nick: c.nick, num: c.num, mon: c.mon, alt: c.alt, blocked: !!c.blocked, log: c.log.slice(0, 30), since: c.since };
}
function log(card, ic, title, sub, amt, cur, sign) {
  card.log.unshift({ ic, title, sub, amt, cur, sign, at: stamp() });
  card.log = card.log.slice(0, 30);
}
function auth(state, nick, pin) {
  const c = state.cards[norm(nick)];
  if (!c) return { err: "Карты с таким ником нет." };
  if (c.pinHash !== hash(String(pin || ""))) return { err: "Неверный ПИН." };
  return { card: c };
}
const int = (v) => Math.floor(Number(v));

async function notify(title, desc, fields, color) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Банк Стамонии",
        allowed_mentions: { parse: [] },
        embeds: [{
          title, description: desc || "", color: color || 0x2e9b2c, fields: fields || [],
          footer: { text: "Государственный банк СФ" }, timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (_) { /* банк работает и без Discord */ }
}

/* ————— обработчик ————— */
export default async (req) => {
  if (req.method !== "POST") return bad("Только POST", 405);

  let body;
  try { body = await req.json(); } catch { return bad("Битый запрос"); }
  const a = body.action;
  const state = await load();

  /* — открыть карту — */
  if (a === "register") {
    const nick = String(body.nick || "").trim();
    const dis = String(body.dis || "").trim();
    const pin = String(body.pin || "").trim();
    if (nick.length < 3 || nick.length > 32) return bad("Ник от 3 до 32 символов.");
    if (!/^[A-Za-z0-9_\-]+$/.test(nick)) return bad("В нике только латиница, цифры, _ и -.");
    if (!dis) return bad("Укажите Discord.");
    if (!/^\d{4}$/.test(pin)) return bad("ПИН — ровно 4 цифры.");
    if (state.cards[norm(nick)]) return bad("Карта на этот ник уже открыта.");

    const card = { nick, dis, pinHash: hash(pin), num: cardNumber(state), mon: 0, alt: 0, blocked: false, log: [], since: stamp() };
    log(card, "★", "Карта открыта", "Добро пожаловать в банк", 0, "mon", 0);
    state.cards[norm(nick)] = card;
    await persist(state);
    await notify("Открыта карта", null, [
      { name: "Игрок", value: nick, inline: true },
      { name: "Карта", value: "`" + card.num + "`", inline: true },
      { name: "Discord", value: "`" + dis + "`", inline: true }
    ]);
    return ok({ card: pub(card) });
  }

  /* — вход и обновление — */
  if (a === "login" || a === "me") {
    const r = auth(state, body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    return ok({ card: pub(r.card) });
  }

  /* — перевод — */
  if (a === "transfer") {
    const r = auth(state, body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    const from = r.card;
    if (from.blocked) return bad("Ваша карта заблокирована казной.");
    const to = find(state, body.to);
    const cur = body.cur === "alt" ? "alt" : "mon";
    const amt = int(body.amount);
    const msg = String(body.msg || "").trim().slice(0, 60);
    if (!to) return bad("Такой карты нет. Проверьте ник или номер.");
    if (to.num === from.num) return bad("Себе переводить нечего.");
    if (to.blocked) return bad("Карта получателя заблокирована.");
    if (!(amt >= 1)) return bad("Сумма должна быть больше нуля.");
    if (from[cur] < amt) return bad("На карте недостаточно средств.");

    from[cur] -= amt; to[cur] += amt;
    const cn = cur === "mon" ? "МОН" : "Алтын";
    log(from, "↗", "Перевод игроку " + to.nick, msg || "без комментария", amt, cur, -1);
    log(to, "↙", "Перевод от " + from.nick, msg || "без комментария", amt, cur, 1);
    await persist(state);
    await notify("Перевод", msg || null, [
      { name: "От", value: from.nick + "\n`" + from.num + "`", inline: true },
      { name: "Кому", value: to.nick + "\n`" + to.num + "`", inline: true },
      { name: "Сумма", value: "**" + money(amt) + " " + cn + "**", inline: true }
    ]);
    return ok({ card: pub(from), note: "Отправлено: " + money(amt) + " " + cn + " игроку " + to.nick + "." });
  }

  /* — налог — */
  if (a === "tax") {
    const r = auth(state, body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    const c = r.card;
    if (c.blocked) return bad("Карта заблокирована казной.");
    const no = String(body.receipt || "").trim().slice(0, 24);
    const amt = int(body.amount);
    if (!no) return bad("Введите номер квитанции.");
    if (!(amt >= 1)) return bad("Введите сумму налога.");
    if (c.mon < amt) return bad("На карте не хватает МОН.");
    c.mon -= amt;
    log(c, "⚖", "Налог оплачен", no, amt, "mon", -1);
    await persist(state);
    await notify("Налог оплачен", null, [
      { name: "Плательщик", value: c.nick + "\n`" + c.num + "`", inline: true },
      { name: "Квитанция", value: "`" + no + "`", inline: true },
      { name: "Сумма", value: "**" + money(amt) + " МОН**", inline: true }
    ], 0xe3c35a);
    return ok({ card: pub(c), note: "Налог по квитанции " + no + " оплачен." });
  }

  /* — обмен — */
  if (a === "exchange") {
    const r = auth(state, body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    const c = r.card;
    if (c.blocked) return bad("Карта заблокирована казной.");
    const amt = int(body.amount);
    if (!(amt >= 1)) return bad("Введите сумму обмена.");
    let note;
    if (body.dir === "m2a") {
      if (c.mon < amt) return bad("Не хватает МОН.");
      c.mon -= amt; c.alt += amt * RATE;
      log(c, "⇄", "Обмен МОН на Алтын", "курс 1 : " + RATE, amt, "mon", -1);
      note = "Обменяно: " + money(amt) + " МОН → " + money(amt * RATE) + " Алтын.";
    } else {
      if (amt < RATE) return bad("Минимум " + RATE + " Алтын за один МОН.");
      if (c.alt < amt) return bad("Не хватает Алтын.");
      const got = Math.floor(amt / RATE), spent = got * RATE;
      c.alt -= spent; c.mon += got;
      log(c, "⇄", "Обмен Алтын на МОН", "курс " + RATE + " : 1", spent, "alt", -1);
      note = "Обменяно: " + money(spent) + " Алтын → " + money(got) + " МОН.";
    }
    await persist(state);
    return ok({ card: pub(c), note });
  }

  /* — казна — */
  const CODE = process.env.TREASURER_CODE || "";
  const isTreasurer = () => CODE && String(body.code || "") === CODE;

  if (a === "tre_list") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const all = Object.values(state.cards).map((c) => ({ nick: c.nick, num: c.num, mon: c.mon, alt: c.alt, blocked: !!c.blocked }));
    return ok({
      cards: all.sort((x, y) => y.mon - x.mon),
      totalMon: all.reduce((s, c) => s + c.mon, 0),
      totalAlt: all.reduce((s, c) => s + c.alt, 0)
    });
  }

  if (a === "tre_issue") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    const cur = body.cur === "alt" ? "alt" : "mon";
    const amt = int(body.amount);
    const why = String(body.why || "").trim().slice(0, 60);
    if (!c) return bad("Карта не найдена.");
    if (!amt) return bad("Введите сумму: плюс — начисление, минус — списание.");
    if (amt < 0 && c[cur] < Math.abs(amt)) return bad("На карте меньше средств, чем вы списываете.");
    c[cur] += amt;
    const cn = cur === "mon" ? "МОН" : "Алтын";
    log(c, amt > 0 ? "◆" : "⚑", amt > 0 ? "Начисление из казны" : "Списание в казну", why || "без основания", Math.abs(amt), cur, amt > 0 ? 1 : -1);
    await persist(state);
    await notify(amt > 0 ? "Начисление из казны" : "Списание в казну", why || null, [
      { name: "Игрок", value: c.nick + "\n`" + c.num + "`", inline: true },
      { name: "Сумма", value: "**" + (amt > 0 ? "+" : "−") + money(Math.abs(amt)) + " " + cn + "**", inline: true },
      { name: "Остаток", value: money(c[cur]) + " " + cn, inline: true }
    ], amt > 0 ? 0x3dbe38 : 0xff6b5e);
    return ok({ note: (amt > 0 ? "Начислено " : "Списано ") + money(Math.abs(amt)) + " " + cn + " · " + c.nick + "." });
  }

  if (a === "tre_block") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    if (!c) return bad("Карта не найдена.");
    c.blocked = !c.blocked;
    await persist(state);
    await notify(c.blocked ? "Карта заблокирована" : "Карта разблокирована", null, [
      { name: "Игрок", value: c.nick, inline: true },
      { name: "Карта", value: "`" + c.num + "`", inline: true }
    ], c.blocked ? 0xff6b5e : 0x3dbe38);
    return ok({ note: c.blocked ? "Карта " + c.nick + " заблокирована." : "Карта " + c.nick + " разблокирована." });
  }

  if (a === "tre_reset_pin") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    const pin = String(body.pin || "");
    if (!c) return bad("Карта не найдена.");
    if (!/^\d{4}$/.test(pin)) return bad("Новый ПИН — 4 цифры.");
    c.pinHash = hash(pin);
    await persist(state);
    return ok({ note: "ПИН карты " + c.nick + " изменён." });
  }

  return bad("Неизвестное действие.");
};

export const config = { path: "/api/bank" };
