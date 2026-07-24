import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/* ————— настройки ————— */
const RATE = 16;                                  // 1 Алтын = 16 МОН
const AVATAR_LIMIT = 60000;                       // ~45 КБ на аватарку
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
  const s = raw || { cards: {}, seq: 0 };
  if (!s.settings) s.settings = { payday: { next: "", periodDays: 7, note: "" } };
  return s;
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
  return {
    nick: c.nick, num: c.num, mon: c.mon, alt: c.alt, blocked: !!c.blocked,
    log: c.log.slice(0, 30), since: c.since,
    avatar: c.avatar || "", bio: c.bio || "", dis: c.dis || "", discordId: c.discordId || "",
    fines: (c.fines || []).filter((f) => !f.paid)
  };
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

async function notify(title, desc, fields, color, opts) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) return;
  const o = opts || {};
  try {
    const body = {
      username: "Банк Стамонии",
      allowed_mentions: { parse: [], users: (o.mentions || []).slice(0, 25) },
      embeds: [{
        title, description: desc || "", color: color || 0x2e9b2c, fields: fields || [],
        footer: { text: "Государственный банк СФ" }, timestamp: new Date().toISOString()
      }]
    };
    if (o.content) body.content = o.content;
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (_) { /* банк работает и без Discord */ }
}

/* — день зарплаты: объявление, когда время пришло — */
const tzOf = (p) => Number(p.tz || 0);
function paydayMs(p) {
  if (!p || !p.next) return NaN;
  const base = Date.parse(p.next.length === 16 ? p.next + ":00Z" : p.next + "Z");
  return isNaN(base) ? NaN : base + tzOf(p) * 60000;
}
function msToInput(ms, tz) {
  const d = new Date(ms - tz * 60000), p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + "T" + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
async function checkPayday(state) {
  const p = state.settings && state.settings.payday;
  if (!p || !p.next) return false;
  let t = paydayMs(p);
  if (isNaN(t) || t > Date.now()) return false;

  const ids = Object.values(state.cards).map((c) => c.discordId).filter(Boolean).slice(0, 25);
  await notify("День зарплаты", p.note || "Казна выплачивает жалование гражданам.", [
    { name: "Когда", value: "прямо сейчас", inline: true },
    { name: "Следующая", value: p.periodDays ? "через " + p.periodDays + " дн." : "не запланирована", inline: true }
  ], 0x3dbe38, {
    content: (ids.map((i) => "<@" + i + ">").join(" ") + " **Сегодня день зарплаты**").trim(),
    mentions: ids
  });

  const per = (p.periodDays || 0) * 86400000;
  if (per > 0) { while (t <= Date.now()) t += per; p.next = msToInput(t, tzOf(p)); }
  else p.next = "";
  await persist(state);
  return true;
}

/* ————— обработчик ————— */
export default async (req) => {
  if (req.method !== "POST") return bad("Только POST", 405);

  let body;
  try { body = await req.json(); } catch { return bad("Битый запрос"); }
  const a = body.action;
  const state = await load();
  await checkPayday(state);

  /* — открыть карту — */
  if (a === "register") {
    const nick = String(body.nick || "").trim();
    const dis = String(body.dis || "").trim();
    const pin = String(body.pin || "").trim();
    if (nick.length < 3 || nick.length > 32) return bad("Ник от 3 до 32 символов.");
    if (!/^[A-Za-z0-9_\-]+$/.test(nick)) return bad("В нике только латиница, цифры, _ и -.");
    if (!/^\d{4}$/.test(pin)) return bad("ПИН — ровно 4 цифры.");
    if (state.cards[norm(nick)]) return bad("Карта на этот ник уже открыта.");

    const card = { nick, dis, discordId: String(body.discordId || "").replace(/\D/g, "").slice(0, 20), pinHash: hash(pin), num: cardNumber(state), mon: 0, alt: 0, blocked: false, log: [], since: stamp(), avatar: "", bio: "", fines: [] };
    log(card, "★", "Карта открыта", "Добро пожаловать в банк", 0, "mon", 0);
    state.cards[norm(nick)] = card;
    await persist(state);
    await notify("Открыта карта", null, [
      { name: "Игрок", value: nick, inline: true },
      { name: "Карта", value: "`" + card.num + "`", inline: true },
      { name: "Discord", value: dis ? "`" + dis + "`" : "не указан", inline: true }
    ]);
    return ok({ card: pub(card) });
  }

  /* — вход и обновление — */
  if (a === "login" || a === "me") {
    const r = auth(state, body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    return ok({ card: pub(r.card), settings: state.settings });
  }

  /* — оплата штрафа — */
  if (a === "pay_fine") {
    const r = auth(state, body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    const c = r.card;
    c.fines = c.fines || [];
    const f = c.fines.find((x) => x.id === String(body.id) && !x.paid);
    if (!f) return bad("Штраф не найден или уже оплачен.");
    const cur = f.cur === "alt" ? "alt" : "mon";
    const cn = cur === "mon" ? "МОН" : "Алтын";
    if (c[cur] < f.amount) return bad("Не хватает средств: нужно " + money(f.amount) + " " + cn + ".");
    c[cur] -= f.amount;
    f.paid = true; f.paidAt = stamp();
    c.fines = c.fines.filter((x) => !x.paid);
    log(c, "⚖", "Штраф оплачен", f.article ? "ст. " + f.article + " · " + f.reason : f.reason, f.amount, cur, -1);
    await persist(state);
    await notify("Штраф оплачен", f.reason || null, [
      { name: "Игрок", value: c.nick + "\n`" + c.num + "`", inline: true },
      { name: "Статья", value: f.article ? "ст. " + f.article : "без статьи", inline: true },
      { name: "Сумма", value: "**" + money(f.amount) + " " + cn + "**", inline: true }
    ], 0xe3c35a);
    return ok({ card: pub(c), note: "Штраф погашен: " + money(f.amount) + " " + cn + "." });
  }

  /* — профиль — */
  if (a === "profile") {
    const r = auth(state, body.nick, body.pin);
    if (r.err) return bad(r.err, 401);
    const c = r.card;
    const av = String(body.avatar || "");
    if (av && av.length > AVATAR_LIMIT) return bad("Аватарка слишком тяжёлая, возьмите картинку поменьше.");
    if (av && !/^(data:image\/|https:\/\/)/.test(av)) return bad("Неверная картинка.");
    c.avatar = av;
    c.bio = String(body.bio || "").trim().slice(0, 60);
    if (body.discordId !== undefined) c.discordId = String(body.discordId).replace(/\D/g, "").slice(0, 20);
    if (body.dis) c.dis = String(body.dis).trim().slice(0, 40);
    await persist(state);
    return ok({ card: pub(c), note: "Профиль сохранён." });
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
      if (amt < RATE) return bad("Минимум " + RATE + " МОН за один Алтын.");
      if (c.mon < amt) return bad("Не хватает МОН.");
      const got = Math.floor(amt / RATE), spent = got * RATE;
      c.mon -= spent; c.alt += got;
      log(c, "⇄", "Обмен МОН на Алтын", "курс " + RATE + " : 1", spent, "mon", -1);
      note = "Обменяно: " + money(spent) + " МОН → " + money(got) + " Алтын.";
    } else {
      if (c.alt < amt) return bad("Не хватает Алтын.");
      c.alt -= amt; c.mon += amt * RATE;
      log(c, "⇄", "Обмен Алтын на МОН", "курс 1 : " + RATE, amt, "alt", -1);
      note = "Обменяно: " + money(amt) + " Алтын → " + money(amt * RATE) + " МОН.";
    }
    await persist(state);
    await notify("Обмен валют", null, [
      { name: "Игрок", value: c.nick + "\n`" + c.num + "`", inline: true },
      { name: "Операция", value: note, inline: false },
      { name: "Стало", value: money(c.mon) + " МОН · " + money(c.alt) + " Алтын", inline: true }
    ], 0xe3c35a);
    return ok({ card: pub(c), note });
  }

  /* — казна — */
  const CODE = process.env.TREASURER_CODE || "";
  const isTreasurer = () => CODE && String(body.code || "") === CODE;

  if (a === "tre_list") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const all = Object.values(state.cards).map((c) => ({
      nick: c.nick, num: c.num, mon: c.mon, alt: c.alt, blocked: !!c.blocked, avatar: c.avatar || "",
      fines: (c.fines || []).filter((f) => !f.paid)
    }));
    return ok({
      cards: all.sort((x, y) => y.mon - x.mon),
      totalMon: all.reduce((s, c) => s + c.mon, 0),
      totalAlt: all.reduce((s, c) => s + c.alt, 0),
      settings: state.settings
    });
  }

  /* — штрафы — */
  if (a === "tre_fine") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    const amt = int(body.amount);
    const cur = body.cur === "alt" ? "alt" : "mon";
    const cn = cur === "mon" ? "МОН" : "Алтын";
    const article = String(body.article || "").trim().slice(0, 8);
    const reason = String(body.reason || "").trim().slice(0, 80);
    if (!c) return bad("Карта не найдена.");
    if (!(amt >= 1)) return bad("Сумма штрафа должна быть больше нуля.");
    if (!reason) return bad("Укажите, за что штраф.");
    c.fines = c.fines || [];
    c.fines.push({ id: newId(), amount: amt, cur, article, reason, at: stamp(), paid: false });
    log(c, "!", "Выписан штраф", article ? "ст. " + article + " · " + reason : reason, amt, cur, 0);
    await persist(state);
    await notify("Выписан штраф", reason, [
      { name: "Игрок", value: c.nick + "\n`" + c.num + "`", inline: true },
      { name: "Статья", value: article ? "ст. " + article : "без статьи", inline: true },
      { name: "Сумма", value: "**" + money(amt) + " " + cn + "**", inline: true },
      { name: "Как оплатить", value: "Банк → вкладка «Штрафы» → «Оплатить»" }
    ], 0xff6b5e, c.discordId ? {
      content: "<@" + c.discordId + "> вам выписан штраф на **" + money(amt) + " " + cn + "**" + (article ? " по ст. " + article : ""),
      mentions: [c.discordId]
    } : { content: "**" + c.nick + "** — вам выписан штраф на " + money(amt) + " " + cn });
    return ok({ note: "Штраф " + money(amt) + " " + cn + " выписан игроку " + c.nick + "." });
  }

  if (a === "tre_fine_cancel") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    if (!c) return bad("Карта не найдена.");
    c.fines = c.fines || [];
    const before = c.fines.length;
    c.fines = c.fines.filter((f) => f.id !== String(body.id));
    if (c.fines.length === before) return bad("Штраф не найден.");
    log(c, "✎", "Штраф отменён", "решение казны", 0, "mon", 0);
    await persist(state);
    await notify("Штраф отменён", null, [{ name: "Игрок", value: c.nick, inline: true }], 0x3dbe38);
    return ok({ note: "Штраф отменён." });
  }

  /* — день зарплаты — */
  if (a === "tre_payday") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const next = String(body.next || "").slice(0, 20);
    const per = Math.max(0, Math.min(365, int(body.periodDays) || 0));
    const tz = Math.max(-840, Math.min(840, int(body.tz) || 0));
    state.settings.payday = { next, periodDays: per, note: String(body.note || "").trim().slice(0, 60), tz };
    await persist(state);
    if (next) {
      await notify("День зарплаты назначен", state.settings.payday.note || null, [
        { name: "Когда", value: next.replace("T", " в "), inline: true },
        { name: "Повтор", value: per ? "каждые " + per + " дн." : "разово", inline: true }
      ], 0x3dbe38);
    }
    return ok({ note: next ? "День зарплаты установлен." : "Таймер зарплаты выключен.", settings: state.settings });
  }

  if (a === "tre_issue") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    const cur = body.cur === "alt" ? "alt" : "mon";
    const why = String(body.why || "").trim().slice(0, 60);
    const cn = cur === "mon" ? "МОН" : "Алтын";
    if (!c) return bad("Карта не найдена.");

    /* точная установка баланса */
    if (body.mode === "set") {
      const val = int(body.amount);
      if (!(val >= 0)) return bad("Баланс не может быть отрицательным.");
      const diff = val - c[cur];
      c[cur] = val;
      log(c, "✎", "Баланс изменён казной", why || "ручная правка", Math.abs(diff), cur, diff === 0 ? 0 : (diff > 0 ? 1 : -1));
      await persist(state);
      await notify("Баланс изменён вручную", why || null, [
        { name: "Игрок", value: c.nick + "\n`" + c.num + "`", inline: true },
        { name: "Стало", value: "**" + money(val) + " " + cn + "**", inline: true },
        { name: "Разница", value: (diff >= 0 ? "+" : "−") + money(Math.abs(diff)) + " " + cn, inline: true }
      ], 0xe3c35a);
      return ok({ note: "Баланс " + c.nick + " теперь " + money(val) + " " + cn + "." });
    }

    const amt = int(body.amount);
    if (!amt) return bad("Введите сумму: плюс — начисление, минус — списание.");
    if (amt < 0 && c[cur] < Math.abs(amt)) return bad("На карте меньше средств, чем вы списываете.");
    c[cur] += amt;
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

  if (a === "tre_delete") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    if (!c) return bad("Карта не найдена.");
    const snapshot = { nick: c.nick, num: c.num, mon: c.mon, alt: c.alt };
    delete state.cards[norm(c.nick)];
    await persist(state);
    await notify("Карта закрыта", "Счёт удалён казначеем, игрок может открыть новый.", [
      { name: "Игрок", value: snapshot.nick, inline: true },
      { name: "Карта", value: "`" + snapshot.num + "`", inline: true },
      { name: "Остаток на момент закрытия", value: money(snapshot.mon) + " МОН · " + money(snapshot.alt) + " Алтын", inline: false }
    ], 0xff6b5e);
    return ok({ note: "Карта " + snapshot.nick + " закрыта. Теперь он может открыть новую." });
  }

  if (a === "tre_setid") {
    if (!isTreasurer()) return bad("Неверный код казначея.", 401);
    const c = find(state, body.target);
    if (!c) return bad("Карта не найдена.");
    const id = String(body.discordId || "").replace(/\D/g, "").slice(0, 20);
    c.discordId = id;
    if (body.dis) c.dis = String(body.dis).trim().slice(0, 40);
    await persist(state);
    return ok({ note: id ? "Discord привязан к карте " + c.nick + " — банк будет его отмечать." : "Привязка Discord убрана у " + c.nick + "." });
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
