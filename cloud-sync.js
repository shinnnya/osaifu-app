// おさいふ Ver.0.7: Firebase Authentication + Cloud Firestore 自動同期
// 変更された給与期間のドキュメントと支払い予定だけを同期する。
// 復元元は Firebase Authentication の同一アカウント。
(() => {
  "use strict";
  const CONFIG = window.OSAIFU_FIREBASE_CONFIG || {};
  const enabled = ["apiKey", "authDomain", "projectId", "appId"]
    .every(k => typeof CONFIG[k] === "string" && CONFIG[k].trim() !== "");
  const STATUS = document.getElementById("cloud-status");
  const LOGIN = document.getElementById("cloud-login");
  const LOADING = document.getElementById("cloud-loading");
  const ERROR = document.getElementById("login-error");
  const QUEUE_KEY = "osaifu-cloud-queue-v1";
  const LINKED_KEY = "osaifu-cloud-linked-uid-v1";
  const serial = value => JSON.parse(JSON.stringify(value));
  let auth = null;
  let db = null;
  let user = null;
  let ready = false;
  let pushing = false;
  let retryTimer = null;
  let createMode = false;
  let queue = {ownerUid:null, periods:{}, payments:null};
  try {
    const stored = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null");
    if (stored && stored.periods && typeof stored.periods === "object") queue = stored;
  } catch(e) { console.warn("同期キューの読み込み失敗", e); }

  function label(value, kind = "") {
    STATUS.textContent = value;
    STATUS.className = "cloud-status" + (kind ? " " + kind : "");
  }
  function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }
    catch (error) { label("同期保留を保存できません", "error"); console.error(error); }
  }
  function hasQueue() {
    return Object.keys(queue.periods).length > 0 || queue.payments !== null;
  }
  function showAuth() {
    for (const id of ["main-screen", "initial-screen", "salary-screen"]) document.getElementById(id).hidden = true;
    LOADING.hidden = true;
    LOGIN.hidden = false;
    label("ログインが必要", "pending");
  }
  function showLoading(msg) {
    for (const id of ["main-screen", "initial-screen", "salary-screen"]) document.getElementById(id).hidden = true;
    LOGIN.hidden = true;
    LOADING.hidden = false;
    document.getElementById("cloud-loading-text").textContent = msg;
  }
  function showLoginError(msg) {
    ERROR.textContent = msg;
    ERROR.hidden = false;
  }
  function cloudUserDoc() { return db.collection("users").doc(user.uid); }
  function sortedPeriodKeys() { return Object.keys(data.periods).sort(); }
  function queueMutation(periodKeys, paymentsChanged) {
    if (!enabled) return;
    if (queue.ownerUid && user && queue.ownerUid !== user.uid) {
      label("アカウント相違", "error");
      return;
    }
    if (user) queue.ownerUid = user.uid;
    for (const key of periodKeys) {
      queue.periods[key] = data.periods[key] === undefined ? null : serial(data.periods[key]);
    }
    if (paymentsChanged) queue.payments = serial(data.payments);
    saveQueue();
    if (hasQueue()) label("端末保存済・同期待ち", "pending");
    if (ready) void flush();
  }
  function queueChangedPeriods(keys) { queueMutation(keys, false); }
  window.osaifuCloud = {queueMutation, queueChangedPeriods};

  async function flush() {
    if (!ready || !user || pushing) return;
    if (queue.ownerUid && queue.ownerUid !== user.uid) {
      label("同期先を確認してください", "error");
      return;
    }
    pushing = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try {
      while (hasQueue() && ready && user) {
        label("クラウド同期中…", "pending");
        const keys = Object.keys(queue.periods);
        if (keys.length) {
          const key = keys[0];
          const snapshot = serial(queue.periods[key]);
          const ref = cloudUserDoc().collection("periods").doc(key);
          if (snapshot === null) await ref.delete();
          else await ref.set({record:snapshot, updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
          if (JSON.stringify(queue.periods[key]) === JSON.stringify(snapshot)) {
            delete queue.periods[key];
            saveQueue();
          }
        } else if (queue.payments !== null) {
          const snapshot = serial(queue.payments);
          await cloudUserDoc().collection("meta").doc("payments").set({items:snapshot, updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
          if (JSON.stringify(queue.payments) === JSON.stringify(snapshot)) {
            queue.payments = null;
            saveQueue();
          }
        }
      }
      if (!hasQueue()) label("☁ 保存済み");
    } catch (error) {
      console.warn("クラウド同期は保留", error);
      label("同期保留・再試行", "error");
      retryTimer = setTimeout(() => void flush(), 15000);
    } finally {
      pushing = false;
    }
  }

  function replaceLocalFromCloud(remote) {
    const before = data;
    data = remote;
    if (!save()) {
      data = before;
      throw new Error("端末に復元データを保存できませんでした。");
    }
    // 内部の画面状態も初期化して、以前の支出取り消し先が混ざらないようにする。
    input = "";
    lastRegisteredId = null;
    historyDeleted = null;
    historyEditingId = null;
    paymentEditingId = null;
    activeTab = "home";
    historyPeriodKey = payrollPeriod().key;
    historySelectedDate = dateKey(new Date());
  }
  function hasMeaningfulData(d) {
    return d.payments.length > 0 || Object.values(d.periods).some(r =>
      hasStartingAmount(r) || (r.expenses || []).length > 0);
  }
  function stageAllLocal() {
    for (const key of sortedPeriodKeys()) {
      queue.periods[key] = serial(data.periods[key]);
    }
    queue.payments = serial(data.payments);
    queue.ownerUid = user.uid;
    saveQueue();
  }
  async function fetchAndStart() {
    ready = false;
    showLoading("クラウドの記録を確認しています…");
    label("復元中…", "pending");
    const linkedUid = localStorage.getItem(LINKED_KEY);
    if (linkedUid && linkedUid !== user.uid) throw new Error("この端末には別アカウントの家計簿が残っています。同期を停止しました。");
    if (queue.ownerUid && queue.ownerUid !== user.uid) throw new Error("未同期の記録は別アカウントに紐づいています。");
    const ref = cloudUserDoc();
    const [periodDocs, paymentDoc] = await Promise.all([
      ref.collection("periods").get(),
      ref.collection("meta").doc("payments").get()
    ]);
    const exists = !periodDocs.empty || paymentDoc.exists;
    const localHadData = hasMeaningfulData(data);
    if (!exists) {
      if (localHadData || hasQueue()) stageAllLocal();
      else {
        queue.ownerUid = user.uid;
        saveQueue();
      }
    } else {
      const remote = {version:3, periods:{}, payments:[]};
      for (const doc of periodDocs.docs) {
        const record = doc.data()?.record;
        if (record && typeof record === "object") remote.periods[doc.id] = record;
      }
      if (paymentDoc.exists && Array.isArray(paymentDoc.data()?.items)) remote.payments = paymentDoc.data().items;
      if (localHadData && !linkedUid && !hasQueue()) {
        const ok = confirm("クラウドには以前の家計簿データがあります。\nクラウドの記録をこの端末に復元しますか？\n\nキャンセルすると同期せず、端末の記録を残します。");
        if (!ok) throw new Error("端末側の記録を保護するため、同期を停止しました。再読み込みで確認できます。");
      }
      // 同期前に保存した操作があれば、クラウドを読み込んだ後でその差分だけ適用。
      if (hasQueue()) {
        if (!queue.ownerUid) throw new Error("未同期の記録の所有者を確認できません。クラウドへの上書きを停止しました。");
        for (const [key, value] of Object.entries(queue.periods)) {
          if (value === null) delete remote.periods[key];
          else remote.periods[key] = serial(value);
        }
        if (queue.payments !== null) remote.payments = serial(queue.payments);
      }
      replaceLocalFromCloud(remote);
    }
    localStorage.setItem(LINKED_KEY, user.uid);
    ready = true;
    LOGIN.hidden = true;
    LOADING.hidden = true;
    render();
    if (hasQueue()) void flush();
    else label("☁ 保存済み");
  }

  function authMessage(error) {
    const code = error?.code || "";
    if (code === "auth/email-already-in-use") return "このメールアドレスは登録済みです。ログインを選んでください。";
    if (code === "auth/invalid-email") return "メールアドレスの形式を確認してください。";
    if (code === "auth/weak-password" || code === "auth/password-does-not-meet-requirements") return "パスワードが短いか、条件を満たしていません。";
    if (code === "auth/operation-not-allowed") return "Firebaseでメール／パスワード認証を有効にしてください。";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") return "メールアドレスかパスワードが違います。";
    if (code === "auth/network-request-failed") return "通信できません。ネット接続を確認してください。";
    if (code === "auth/unauthorized-domain") return "Firebaseの承認済みドメインに現在のURLを追加してください。";
    return error?.message || "ログインできませんでした。";
  }
  const loginForm = document.getElementById("login-form");
  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!auth) return;
    ERROR.hidden = true;
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const submit = document.getElementById("login-submit");
    submit.disabled = true;
    try {
      if (createMode) await auth.createUserWithEmailAndPassword(email, password);
      else await auth.signInWithEmailAndPassword(email, password);
      document.getElementById("login-password").value = "";
    } catch(error) {
      showLoginError(authMessage(error));
    } finally { submit.disabled = false; }
  });
  document.getElementById("login-toggle").addEventListener("click", () => {
    createMode = !createMode;
    document.getElementById("login-heading").textContent = createMode ? "初めてのアカウント作成" : "クラウドバックアップ";
    document.getElementById("login-submit").textContent = createMode ? "アカウントを作る" : "ログイン";
    document.getElementById("login-toggle").textContent = createMode ? "すでに登録した方：ログイン" : "初めて使う方：アカウントを作成";
    ERROR.hidden = true;
  });
  document.getElementById("login-reset-password").addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim();
    if (!email) { showLoginError("先にメールアドレスを入力してください。"); return; }
    try {
      await auth.sendPasswordResetEmail(email);
      showLoginError("パスワード再設定メールの送信を受け付けました。メールを確認してください。");
    } catch(error) { showLoginError(authMessage(error)); }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && ready && hasQueue()) void flush();
  });
  window.addEventListener("online", () => {
    if (ready && hasQueue()) void flush();
    else if (user && !ready) void fetchAndStart().catch(showStartError);
  });
  function showStartError(error) {
    console.error("クラウド復元に失敗", error);
    showLoading("同期に失敗しました。" + (error?.message || "インターネットとFirebaseの設定を確認して、ページを再読み込みしてください。"));
    label("同期できません", "error");
  }

  if (!enabled) {
    label("端末保存のみ", "pending");
    console.info("firebase-config.js にFirebase設定を入れると自動バックアップを開始できます。");
    return;
  }
  if (!window.firebase?.apps || typeof window.firebase.auth !== "function" || typeof window.firebase.firestore !== "function") {
    label("Firebase読込失敗", "error");
    return;
  }
  try {
    firebase.initializeApp(CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    showLoading("ログイン状態を確認しています…");
    auth.onAuthStateChanged(async currentUser => {
      user = currentUser;
      ready = false;
      if (!user) { showAuth(); return; }
      try { await fetchAndStart(); }
      catch(error) { showStartError(error); }
    }, showStartError);
  } catch(error) { showStartError(error); }
})();
