// おさいふ Ver.0.7: 電卓 / 給与 / 支払い予定 / カレンダー / クラウド自動同期
// v0.2の保存済み給与と支出は、初回起動時にコピーして引き継ぎます。
const STORAGE_KEY = "osaifu-v3";
const OLD_STORAGE_KEY = "osaifu-v2";
const yen = n => `${n < 0 ? "−" : ""}¥${Math.abs(n).toLocaleString("ja-JP")}`;
const el = id => document.getElementById(id);
const dayDate = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const jpDay = d => `${d.getMonth() + 1}月${d.getDate()}日`;
const parseDate = key => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || "")) return null;
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
};

function payday(year, monthIndex) {
  const d = new Date(year, monthIndex, 25);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  return d;
}

function payrollPeriod(today = new Date()) {
  const thisPayday = payday(today.getFullYear(), today.getMonth());
  const start = dayDate(today) >= thisPayday
    ? thisPayday : payday(today.getFullYear(), today.getMonth() - 1);
  return periodFromStart(start);
}

function periodFromStart(start) {
  const next = payday(start.getFullYear(), start.getMonth() + 1);
  const end = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
  return { start, next, end, key: dateKey(start) };
}

// 時差・夏時間の影響を受けない暦日差分。
function daysBetween(a, b) {
  const utc = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(b) - utc(a)) / 86400000);
}

function previousFridayIfWeekend(date) {
  const adjusted = dayDate(date);
  if (adjusted.getDay() === 6) adjusted.setDate(adjusted.getDate() - 1);
  if (adjusted.getDay() === 0) adjusted.setDate(adjusted.getDate() - 2);
  return adjusted;
}

// 31日指定で31日がない月は末日を採用する。
function monthlyNominalDate(year, monthIndex, day) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(day, lastDay));
}

function parseMoney(text) {
  if (!/^\d{1,9}$/.test(String(text))) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function makeId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function load() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (current && current.version === 3 && current.periods && Array.isArray(current.payments)) return current;
  } catch (e) { console.warn("Ver.0.3データ読み込みエラー", e); }
  try {
    const old = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) || "null");
    if (old && old.version === 2 && old.periods && typeof old.periods === "object") {
      return { version: 3, periods: old.periods, payments: [] };
    }
  } catch (e) { console.warn("Ver.0.2データ読み込みエラー", e); }
  return { version: 3, periods: {}, payments: [] };
}

let data = load();
let input = "";
let lastRegisteredId = null;
let editingSalary = false;
let initialSetupMode = "new";
let paymentEditingId = null;
let activeTab = "home";
let historyPeriodKey = payrollPeriod().key;
let historySelectedDate = dateKey(new Date());
let historyEditingId = null;
let historyDeleted = null;

function currentRecord(period) {
  if (!data.periods[period.key]) {
    data.periods[period.key] = { salary: null, initialBalance: null, initialDate: null, reservedAtStart: 0, expenses: [], endingBalance: null };
  }
  return data.periods[period.key];
}

function hasStartingAmount(record) {
  return !!record && (record.salary != null || record.initialBalance != null);
}

function isInitialPeriod(record) {
  return !!record && record.initialBalance != null;
}

function totalSpent(record) {
  return (record.expenses || []).reduce((sum, expense) => sum + expense.amount, 0);
}

// 指定給与期間に実際に差し引かれる支払い予定をすべて列挙する。
// 土日調整で前月に繰り上がるものも拾うため、前後の暦月を調べる。
function occurrences(period) {
  const result = [];
  const start = period.start;
  const end = period.end;
  for (const payment of data.payments) {
    if (payment.type === "once") {
      const nominal = parseDate(payment.date);
      if (!nominal) continue;
      const adjusted = previousFridayIfWeekend(nominal);
      if (adjusted >= start && adjusted <= end) {
        result.push({ payment, adjusted, nominal });
      }
    } else if (payment.type === "monthly") {
      for (let offset = -1; offset <= 2; offset++) {
        const month = new Date(start.getFullYear(), start.getMonth() + offset, 1);
        const nominal = monthlyNominalDate(month.getFullYear(), month.getMonth(), Number(payment.day));
        const adjusted = previousFridayIfWeekend(nominal);
        if (adjusted >= start && adjusted <= end && period.key >= payment.startPeriod) {
          result.push({ payment, adjusted, nominal });
        }
      }
    }
  }
  return result.sort((a, b) => a.adjusted - b.adjusted || a.payment.name.localeCompare(b.payment.name, "ja"));
}

function totalReserved(period) {
  return occurrences(period).reduce((sum, item) => sum + item.payment.amount, 0);
}

// 最初に入力する金額は、その時点で使える額。登録済みの固定費は重ねて引かない。
// ただしその後に追加/変更した支払い予定の差分は反映する。
function reservedToSubtract(period, record) {
  const total = totalReserved(period);
  return isInitialPeriod(record) ? total - (record.reservedAtStart || 0) : total;
}

function availableBalance(period, record) {
  if (!hasStartingAmount(record)) return null;
  const startAmount = isInitialPeriod(record) ? record.initialBalance : record.salary;
  return startAmount - reservedToSubtract(period, record) - totalSpent(record);
}

function parseStartingMoney(text) {
  if (!/^\d{1,9}$/.test(String(text))) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error("保存に失敗", e);
    alert("保存できませんでした。ブラウザの容量やプライベートモードを確認してください。");
    return false;
  }
}

// 保存に失敗した場合は画面上のデータも元に戻す。
function commit(change) {
  const previous = JSON.stringify(data);
  const before = JSON.parse(previous);
  change();
  if (!save()) {
    data = before;
    return false;
  }
  // 変更した給与期間と支払い予定だけを送信する（全履歴は毎回送らない）。
  const keys = new Set([...Object.keys(before.periods), ...Object.keys(data.periods)]);
  const periods = [...keys].filter(key => JSON.stringify(before.periods[key]) !== JSON.stringify(data.periods[key]));
  const paymentsChanged = JSON.stringify(before.payments) !== JSON.stringify(data.payments);
  window.osaifuCloud?.queueMutation(periods, paymentsChanged);
  return true;
}

function archiveOldPeriods(currentKey) {
  let changed = false;
  for (const [key, record] of Object.entries(data.periods)) {
    if (key < currentKey && hasStartingAmount(record) && record.endingBalance == null) {
      const start = parseDate(key);
      if (!start) continue;
      record.endingBalance = availableBalance(periodFromStart(start), record);
      changed = true;
    }
  }
  if (changed) {
    const keys = Object.entries(data.periods)
      .filter(([key, record]) => key < currentKey && record.endingBalance !== null)
      .map(([key]) => key);
    if (save()) window.osaifuCloud?.queueChangedPeriods(keys);
  }
}

// 利用開始時の残額入力。既存の給与期間を変更する場合も、この画面から行う。
function showInitialForm(period, record, mode = "new") {
  initialSetupMode = mode;
  el("main-screen").hidden = true;
  el("salary-screen").hidden = true;
  el("initial-screen").hidden = false;
  el("initial-title").textContent = mode === "new" ? "いま使えるお金を入力" : mode === "edit" ? "開始時の残額を修正" : "いまの残額で始め直す";
  el("initial-description").textContent = mode === "edit"
    ? "使い始めた日に入力した金額を修正します。これまでの支出履歴は残します。"
    : mode === "reset"
      ? "今期の給与・通常支出の記録を取り消し、今日から残額を登録し直します。支払い予定は残ります。"
      : "今日から家計簿を使い始めます。固定費などを確保した後の、いま自由に使える金額を入力してください。";
  el("initial-period").textContent = `今日：${jpDay(new Date())} ／ 次の給料日：${jpDay(period.next)}`;
  el("initial-input").value = mode === "edit" ? String(record.initialBalance) : "";
  el("initial-save").disabled = mode !== "edit";
  el("initial-save").textContent = mode === "edit" ? "変更を保存する" : "この残額で始める";
  el("initial-cancel").hidden = mode === "new";
  el("initial-salary-option").hidden = mode !== "new";
}

function showSalaryForm(period, record, edit = false) {
  editingSalary = edit;
  el("main-screen").hidden = true;
  el("initial-screen").hidden = true;
  el("salary-screen").hidden = false;
  el("salary-title").textContent = edit ? "給与額を修正" : "給与を登録";
  el("salary-intro").textContent = edit ? "登録した給与額を変更できます。" : "新しい給与期間が始まりました。手取り給与を入力してください。";
  el("salary-period").textContent = `対象期間：${jpDay(period.start)}〜${jpDay(period.end)}`;
  el("salary-input").value = edit ? String(record.salary) : "";
  el("salary-save").textContent = edit ? "変更を保存する" : "給与を確定する";
  el("salary-save").disabled = !edit;
  el("salary-cancel").hidden = !edit;
}

el("initial-input").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 9);
  el("initial-save").disabled = parseStartingMoney(e.target.value) === null;
});

el("initial-form").addEventListener("submit", e => {
  e.preventDefault();
  const amount = parseStartingMoney(el("initial-input").value);
  if (amount === null) return;
  const period = payrollPeriod();
  const record = currentRecord(period);
  if (initialSetupMode === "reset" && !confirm("今期のテスト用給与と通常の支出記録が消えます。残額から始め直しますか？")) return;
  if (!commit(() => {
    if (initialSetupMode === "edit") {
      record.initialBalance = amount;
    } else {
      record.salary = null;
      record.initialBalance = amount;
      record.initialDate = dateKey(new Date());
      record.reservedAtStart = totalReserved(period);
      record.expenses = [];
      record.endingBalance = null;
    }
  })) return;
  lastRegisteredId = null;
  historyDeleted = null;
  historyPeriodKey = period.key;
  historySelectedDate = dateKey(new Date());
  activeTab = "home";
  render();
});

el("initial-cancel").addEventListener("click", () => render());
el("initial-salary-option").addEventListener("click", () => {
  showSalaryForm(payrollPeriod(), currentRecord(payrollPeriod()));
});

function showTab(tab) {
  activeTab = tab;
  el("home-tab").hidden = tab !== "home";
  el("payments-tab").hidden = tab !== "payments";
  el("history-tab").hidden = tab !== "history";
  for (const name of ["home", "history", "payments"]) {
    const btn = el(`nav-${name}`);
    btn.classList.toggle("active", name === tab);
    if (name === tab) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  if (tab === "payments") renderPaymentList();
  if (tab === "history") renderHistory();
}

function render() {
  const period = payrollPeriod();
  archiveOldPeriods(period.key);
  const record = currentRecord(period);
  if (!hasStartingAmount(record)) {
    // アプリを初めて使う場合だけ残額入力。翌月以降は通常どおり給与登録。
    const hadOtherPeriod = Object.entries(data.periods)
      .some(([key, other]) => key !== period.key && hasStartingAmount(other));
    if (hadOtherPeriod) showSalaryForm(period, record);
    else showInitialForm(period, record);
    return;
  }
  el("initial-screen").hidden = true;
  el("salary-screen").hidden = true;
  el("main-screen").hidden = false;
  const reserved = totalReserved(period);
  const remaining = availableBalance(period, record);
  const days = Math.max(1, daysBetween(dayDate(new Date()), period.next));
  el("balance").textContent = yen(remaining);
  el("daily-budget").textContent = yen(Math.floor(remaining / days));
  el("reserved-hint").textContent = isInitialPeriod(record)
    ? `支払い予定：${yen(reserved)}（開始時に考慮済み。後からの変更差額のみ反映）`
    : `支払い予定：${yen(reserved)}（すでに差し引き済み）`;
  el("edit-salary").textContent = isInitialPeriod(record) ? "開始時の残額を修正" : "給与額を修正";
  el("start-from-balance").hidden = isInitialPeriod(record);
  el("period-hint").textContent = `期間：${jpDay(period.start)}〜${jpDay(period.end)} ／ 次の給料日：${jpDay(period.next)}（残り${days}日）`;
  el("amount").textContent = yen(Number(input || 0));
  el("register").disabled = !(Number(input) > 0);
  el("notice").hidden = lastRegisteredId === null;
  el("planned-total").textContent = yen(reserved);
  showTab(activeTab);
}

el("salary-input").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 9);
  el("salary-save").disabled = !(Number(e.target.value) > 0);
});

el("salary-form").addEventListener("submit", e => {
  e.preventDefault();
  const salary = parseMoney(el("salary-input").value);
  if (salary === null) return;
  const record = currentRecord(payrollPeriod());
  if (!commit(() => { record.salary = salary; })) return;
  editingSalary = false;
  render();
});

el("edit-salary").addEventListener("click", () => {
  const period = payrollPeriod();
  const record = currentRecord(period);
  if (isInitialPeriod(record)) showInitialForm(period, record, "edit");
  else showSalaryForm(period, record, true);
});
el("start-from-balance").addEventListener("click", () => {
  const period = payrollPeriod();
  showInitialForm(period, currentRecord(period), "reset");
});
el("salary-cancel").addEventListener("click", () => { editingSalary = false; render(); });

for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("click", () => {
    const key = button.dataset.key;
    if (key === "delete") input = input.slice(0, -1);
    else if (input.length < 9 && !(input === "" && key === "00")) {
      input = (input + key).replace(/^0+(?=\d)/, "").slice(0, 9);
    }
    render();
  });
}

el("clear").addEventListener("click", () => { input = ""; render(); });

el("register").addEventListener("click", () => {
  const amount = parseMoney(input);
  if (amount === null) return;
  const record = currentRecord(payrollPeriod());
  if (!hasStartingAmount(record)) { render(); return; }
  const entry = { id: makeId(), amount, date: dateKey(new Date()), createdAt: new Date().toISOString() };
  if (!commit(() => record.expenses.push(entry))) return;
  lastRegisteredId = entry.id;
  el("notice-text").textContent = `${yen(amount)}を登録しました`;
  input = "";
  render();
});

el("undo").addEventListener("click", () => {
  if (lastRegisteredId === null) return;
  const record = currentRecord(payrollPeriod());
  const index = record.expenses.findIndex(e => e.id === lastRegisteredId);
  if (index < 0) { lastRegisteredId = null; render(); return; }
  if (!commit(() => { record.expenses.splice(index, 1); })) return;
  lastRegisteredId = null;
  render();
});

// -------- 支払い予定フォーム --------
for (let day = 1; day <= 31; day++) {
  const option = document.createElement("option");
  option.value = String(day);
  option.textContent = `${day}日`;
  el("payment-day").appendChild(option);
}
el("payment-day").value = "20";
el("payment-date").value = dateKey(new Date());

function selectedPaymentType() {
  return document.querySelector('input[name="payment-kind"]:checked').value;
}

function updatePaymentForm() {
  const type = selectedPaymentType();
  el("monthly-field").hidden = type !== "monthly";
  el("once-field").hidden = type !== "once";
  const preview = el("payment-preview");
  if (type === "monthly") {
    preview.textContent = `毎月${el("payment-day").value}日。土日は直前の金曜日に調整し、その日が含まれる給与期間の予算から先取りします。※存在しない日（例：2月31日）は月末扱いです。`;
  } else {
    const nominal = parseDate(el("payment-date").value);
    if (!nominal) { preview.textContent = "支払日を指定してください。"; return; }
    const actual = previousFridayIfWeekend(nominal);
    const target = payrollPeriod(actual);
    preview.textContent = `実際の支払日：${jpDay(actual)}（${dateKey(actual)}）。給与期間：${dateKey(target.start)}〜${dateKey(target.end)} の予算から先取りします。`;
  }
}

document.querySelectorAll('input[name="payment-kind"]').forEach(input => input.addEventListener("change", updatePaymentForm));
el("payment-day").addEventListener("change", updatePaymentForm);
el("payment-date").addEventListener("change", updatePaymentForm);
el("payment-amount").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 9); });

function resetPaymentForm() {
  paymentEditingId = null;
  el("payment-form").reset();
  el("payment-day").value = "20";
  el("payment-date").value = dateKey(new Date());
  el("payment-save").textContent = "支払いを登録する";
  el("payment-cancel").hidden = true;
  updatePaymentForm();
}

el("payment-form").addEventListener("submit", e => {
  e.preventDefault();
  const name = el("payment-name").value.trim();
  const amount = parseMoney(el("payment-amount").value);
  if (!name || amount === null) {
    alert("名前と正しい金額を入力してください。");
    return;
  }
  const type = selectedPaymentType();
  const previous = paymentEditingId ? data.payments.find(p => p.id === paymentEditingId) : null;
  const payment = {
    id: previous?.id || makeId(), name, amount, type,
    startPeriod: previous?.startPeriod || payrollPeriod().key
  };
  if (type === "monthly") payment.day = Number(el("payment-day").value);
  else {
    if (!parseDate(el("payment-date").value)) { alert("支払日を正しく選択してください。"); return; }
    payment.date = el("payment-date").value;
  }
  if (!commit(() => {
    if (previous) data.payments[data.payments.findIndex(p => p.id === previous.id)] = payment;
    else data.payments.push(payment);
  })) return;
  resetPaymentForm();
  render();
});

el("payment-cancel").addEventListener("click", resetPaymentForm);

function addText(parent, className, value, tag="div") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  parent.appendChild(node);
  return node;
}

function renderPaymentList() {
  const list = el("payment-list");
  list.replaceChildren();
  const period = payrollPeriod();
  const scheduled = occurrences(period);
  if (data.payments.length === 0) {
    addText(list, "empty-payments", "まだ支払い予定はありません。");
    return;
  }
  for (const payment of data.payments) {
    const card = document.createElement("div");
    card.className = "payment-item";
    const top = addText(card, "payment-item-top", "");
    addText(top, "payment-item-name", payment.name);
    addText(top, "payment-item-amount", yen(payment.amount));
    const todayEntries = scheduled.filter(x => x.payment.id === payment.id);
    let detail = payment.type === "monthly" ? `毎月${payment.day}日` : `今回だけ・${payment.date}`;
    if (todayEntries.length) detail += ` ／ 今期 ${todayEntries.map(x => jpDay(x.adjusted)).join("・")}・合計${yen(todayEntries.reduce((s, x) => s + x.payment.amount, 0))}`;
    else detail += " ／ 今期の先取りなし";
    addText(card, "payment-item-detail", detail);
    const actions = addText(card, "payment-actions", "");
    const edit = addText(actions, "", "編集", "button");
    edit.type = "button";
    edit.addEventListener("click", () => {
      paymentEditingId = payment.id;
      el("payment-name").value = payment.name;
      el("payment-amount").value = String(payment.amount);
      document.querySelector(`input[name="payment-kind"][value="${payment.type}"]`).checked = true;
      if (payment.type === "monthly") el("payment-day").value = String(payment.day);
      else el("payment-date").value = payment.date;
      el("payment-save").textContent = "変更を保存する";
      el("payment-cancel").hidden = false;
      updatePaymentForm();
      el("payment-name").focus();
      el("payments-tab").scrollIntoView({behavior:"smooth",block:"start"});
    });
    const del = addText(actions, "delete", "削除", "button");
    del.type = "button";
    del.addEventListener("click", () => {
      if (!confirm(`「${payment.name}」を削除しますか？`)) return;
      if (!commit(() => { data.payments = data.payments.filter(p => p.id !== payment.id); })) return;
      if (paymentEditingId === payment.id) resetPaymentForm();
      render();
    });
    list.appendChild(card);
  }
}


// -------- カレンダー履歴 --------
function historyPeriod() {
  const start = parseDate(historyPeriodKey);
  return start ? periodFromStart(start) : payrollPeriod();
}

function historyBalance(period, record) {
  return availableBalance(period, record);
}

function dayEndBalance(period, record, day) {
  if (!hasStartingAmount(record)) return null;
  if (isInitialPeriod(record) && dateKey(day) < record.initialDate) return null;
  const expensesThroughDay = (record.expenses || [])
    .filter(item => item.date <= dateKey(day))
    .reduce((sum, item) => sum + item.amount, 0);
  // 支払い予定は給与期間初日に先取りするため、日ごとの残額計算でも全額控除。
  const base = isInitialPeriod(record) ? record.initialBalance : record.salary;
  return base - reservedToSubtract(period, record) - expensesThroughDay;
}

function shortMoney(value) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return value.toLocaleString("ja-JP");
}

function localButton(label, classes, click) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = classes;
  button.textContent = label;
  button.addEventListener("click", click);
  return button;
}

function periodRecordReadonly(period) {
  return data.periods[period.key] || null;
}

function renderHistory() {
  const period = historyPeriod();
  const nowPeriod = payrollPeriod();
  const record = periodRecordReadonly(period);
  const expenseList = record?.expenses || [];
  const reservedList = occurrences(period);
  const spent = totalSpent({expenses:expenseList});
  const reserved = reservedList.reduce((sum, x) => sum + x.payment.amount, 0);
  const balance = historyBalance(period, record);
  const past = period.start < nowPeriod.start;
  el("history-period").textContent = `${jpDay(period.start)} 〜 ${jpDay(period.end)}`;
  el("history-balance-label").textContent = past ? "給与期間終了時の残額（貯金の記録）" : "今月あと使えるお金";
  el("history-balance").textContent = balance === null ? "未登録" : yen(balance);
  el("history-balance").classList.toggle("missing", balance === null);
  const totals = el("history-totals");
  totals.replaceChildren();
  const startName = isInitialPeriod(record) ? "開始時残額" : "給与";
  const startValue = hasStartingAmount(record) ? yen(isInitialPeriod(record) ? record.initialBalance : record.salary) : "未登録";
  const reservedLabel = isInitialPeriod(record) ? "予定の追加差額" : "支払い予定";
  const reservedValue = isInitialPeriod(record) ? reservedToSubtract(period, record) : reserved;
  for (const [name, value] of [[startName, startValue], [reservedLabel, yen(reservedValue)], ["日々の支出", yen(spent)]]) {
    const item = document.createElement("div");
    addText(item, "", name, "span");
    addText(item, "", value, "strong");
    totals.appendChild(item);
  }

  // 記録がある範囲のみ前の期間へ移動できる。次の期間は現在まで。
  const existingKeys = Object.entries(data.periods)
    .filter(([, rec]) => hasStartingAmount(rec))
    .map(([key]) => key).sort();
  el("history-prev").disabled = existingKeys.length === 0 || period.key <= existingKeys[0];
  el("history-next").disabled = period.key >= nowPeriod.key;
  const calendar = el("history-calendar");
  calendar.replaceChildren();
  for (const word of ["日", "月", "火", "水", "木", "金", "土"]) addText(calendar, "calendar-weekday", word);
  const firstCell = dayDate(period.start);
  firstCell.setDate(firstCell.getDate() - firstCell.getDay());
  const lastCell = dayDate(period.end);
  lastCell.setDate(lastCell.getDate() + (6 - lastCell.getDay()));
  const count = daysBetween(firstCell, lastCell) + 1;
  for (let i = 0; i < count; i++) {
    const day = dayDate(firstCell);
    day.setDate(day.getDate() + i);
    const key = dateKey(day);
    const inPeriod = day >= period.start && day <= period.end;
    const dailySpent = expenseList.filter(e => e.date === key).reduce((sum, e) => sum + e.amount, 0);
    const hasReserved = reservedList.some(x => dateKey(x.adjusted) === key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `calendar-day${inPeriod ? "" : " inactive"}${key === historySelectedDate ? " selected" : ""}`;
    button.disabled = !inPeriod;
    button.setAttribute("aria-label", `${key}、支出${yen(dailySpent)}${hasReserved ? "、支払い予定あり" : ""}`);
    addText(button, "date-number", day.getDate() === 1 || key === period.key ? `${day.getMonth()+1}/${day.getDate()}` : String(day.getDate()), "span");
    if (inPeriod) {
      if (isInitialPeriod(record) && key === record.initialDate) addText(button, "date-salary", "開始", "span");
      else if (!isInitialPeriod(record) && key === period.key) addText(button, "date-salary", "＋給", "span");
      if (dailySpent > 0) addText(button, "date-spent", `−${shortMoney(dailySpent)}`, "span");
      if (hasReserved) addText(button, "payment-dot", "●", "span");
      button.addEventListener("click", () => {
        historySelectedDate = key;
        historyEditingId = null;
        historyDeleted = null;
        renderHistory();
      });
    }
    calendar.appendChild(button);
  }
  renderHistoryDay(period, record, reservedList);
}

function renderHistoryDay(period, record, reservedList) {
  const day = parseDate(historySelectedDate) || period.start;
  el("history-selected-title").textContent = `${day.getMonth()+1}月${day.getDate()}日（${"日月火水木金土"[day.getDay()]}）`;
  const contents = el("history-selected-contents");
  contents.replaceChildren();
  if (isInitialPeriod(record) && historySelectedDate === record.initialDate) {
    const line = addText(contents, "history-line", "");
    addText(line, "", "利用開始時の残額");
    addText(line, "history-positive", yen(record.initialBalance), "strong");
    addText(contents, "history-note", "初期残額には登録時点の支払い予定が織り込み済みです。");
  } else if (historySelectedDate === period.key && hasStartingAmount(record) && !isInitialPeriod(record)) {
    const line = addText(contents, "history-line", "");
    addText(line, "", "給与入金");
    addText(line, "history-positive", `＋${yen(record.salary)}`, "strong");
    addText(contents, "history-note", "支払い予定はこの給与期間の初日にまとめて予算から差し引いています。");
  }
  for (const item of reservedList.filter(x => dateKey(x.adjusted) === historySelectedDate)) {
    const line = addText(contents, "history-line", "");
    addText(line, "", item.payment.name);
    addText(line, "", yen(item.payment.amount), "strong");
    addText(contents, "history-note", isInitialPeriod(record)
      ? "支払い予定：開始時に考慮済み（登録後の追加・変更差額だけ予算に反映）"
      : "支払い予定：給与日に先取り済み（二重計上なし）");
  }
  const selectedExpenses = (record?.expenses || []).filter(e => e.date === historySelectedDate);
  if (!selectedExpenses.length) addText(contents, "history-empty", "この日の通常の支出記録はありません。");
  selectedExpenses.forEach((entry, idx) => {
    const line = addText(contents, "history-item", "");
    if (entry.id === historyEditingId) {
      const form = document.createElement("form");
      form.className = "history-edit";
      const edit = document.createElement("input");
      edit.type = "text";
      edit.inputMode = "numeric";
      edit.maxLength = 9;
      edit.value = String(entry.amount);
      edit.setAttribute("aria-label", "修正する金額");
      edit.addEventListener("input", () => { edit.value = edit.value.replace(/\D/g, "").slice(0,9); });
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "save-edit";
      save.textContent = "保存";
      const cancel = localButton("戻る", "", () => { historyEditingId = null; renderHistory(); });
      form.append(edit, save, cancel);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const amount = parseMoney(edit.value);
        if (amount === null) { alert("1円以上の金額を入力してください。"); return; }
        if (!commit(() => {
          entry.amount = amount;
          if (record.endingBalance !== null) record.endingBalance = historyBalance(period, record);
        })) return;
        historyEditingId = null;
        render();
      });
      line.appendChild(form);
    } else {
      addText(line, "", `支出 ${idx+1}`);
      addText(line, "", yen(entry.amount), "strong");
      const actions = addText(line, "history-actions", "");
      actions.appendChild(localButton("変更", "", () => { historyEditingId = entry.id; historyDeleted = null; renderHistory(); }));
      actions.appendChild(localButton("削除", "danger", () => {
        if (!confirm(`${yen(entry.amount)} の支出を削除しますか？`)) return;
        if (!commit(() => {
          record.expenses = record.expenses.filter(e => e.id !== entry.id);
          if (record.endingBalance !== null) record.endingBalance = historyBalance(period, record);
        })) return;
        historyDeleted = {periodKey: period.key, entry};
        if (lastRegisteredId === entry.id) lastRegisteredId = null;
        render();
      }));
    }
  });
  const undo = historyDeleted && historyDeleted.periodKey === period.key;
  el("history-undo").hidden = !undo;
  const remaining = dayEndBalance(period, record, day);
  el("history-day-balance").textContent = remaining === null ? "—" : yen(remaining);
}

el("history-prev").addEventListener("click", () => {
  const period = historyPeriod();
  const before = payday(period.start.getFullYear(), period.start.getMonth() - 1);
  historyPeriodKey = dateKey(before);
  historySelectedDate = historyPeriodKey;
  historyEditingId = null;
  historyDeleted = null;
  renderHistory();
});
el("history-next").addEventListener("click", () => {
  const period = historyPeriod();
  const after = payday(period.start.getFullYear(), period.start.getMonth() + 1);
  historyPeriodKey = dateKey(after);
  historySelectedDate = historyPeriodKey === payrollPeriod().key ? dateKey(new Date()) : historyPeriodKey;
  historyEditingId = null;
  historyDeleted = null;
  renderHistory();
});
el("history-restore").addEventListener("click", () => {
  if (!historyDeleted) return;
  const {periodKey, entry} = historyDeleted;
  const period = periodFromStart(parseDate(periodKey));
  const record = data.periods[periodKey];
  if (!record) return;
  if (!commit(() => {
    record.expenses.push(entry);
    if (record.endingBalance !== null) record.endingBalance = historyBalance(period, record);
  })) return;
  historyDeleted = null;
  render();
});

el("nav-home").addEventListener("click", () => showTab("home"));
el("nav-history").addEventListener("click", () => showTab("history"));
el("nav-payments").addEventListener("click", () => showTab("payments"));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !editingSalary && el("initial-screen").hidden) render();
});
updatePaymentForm();
render();
