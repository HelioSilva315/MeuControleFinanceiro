const CACHE = "nosso-caixa-v10";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    }).catch(() => {})
  );
});

/* ---- Avisos de vencimento em segundo plano (Periodic Background Sync) ---- */
const IDB_NAME = "nossoCaixa.notif";
const IDB_STORE = "kv";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(key) {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function idbSet(key, val) {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

function swTodayISO() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function swBRL(v) {
  return "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function runDueCheck() {
  try {
    const schedule = (await idbGet("schedule")) || [];
    const notified = (await idbGet("notified")) || {};
    const hoje = swTodayISO();

    const fresh = schedule.filter((it) => it && it.key && it.key <= hoje &&
      !notified[it.kind + ":" + it.id + ":" + it.key + ":" + hoje]);

    if (fresh.length) {
      const icon = "./icons/icon-192.png";
      if (fresh.length === 1) {
        const it = fresh[0];
        const isC = it.kind === "conta";
        await self.registration.showNotification(
          (isC ? "Conta" : "Recebível") + (it.key < hoje ? " atrasada" : " vence hoje"),
          { body: it.label + " · " + swBRL(it.valor), tag: it.kind + "-" + it.id, icon, badge: icon }
        );
      } else {
        const partes = fresh.slice(0, 3).map((x) =>
          (x.kind === "conta" ? "Pagar" : "Receber") + ": " + x.label + " (" + swBRL(x.valor) + ")");
        if (fresh.length > 3) partes.push("e mais " + (fresh.length - 3) + "...");
        await self.registration.showNotification(fresh.length + " vencimentos para hoje",
          { body: partes.join("\n"), tag: "due-summary", icon, badge: icon });
      }
      fresh.forEach((it) => { notified[it.kind + ":" + it.id + ":" + it.key + ":" + hoje] = true; });
    }

    Object.keys(notified).forEach((k) => { if (k.slice(-10) !== hoje) delete notified[k]; });
    await idbSet("notified", notified);
  } catch (e) {}
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "due-check") event.waitUntil(runDueCheck());
});
