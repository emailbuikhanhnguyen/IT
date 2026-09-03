/* sw.js — Service Worker cho IT Asset Inventory PWA
   (Bản trước đó bị dán nhầm nội dung employees.js vào đây, khiến app
   không có Service Worker thật — mọi thứ chỉ chạy được khi có mạng.
   File này thay thế bằng code Service Worker thật.)

   Chiến lược:
   - App shell (index.html, css, js nội bộ, logo, manifest): cache-first,
     precache ngay khi cài đặt -> mở app không mạng vẫn chạy được.
   - Thư viện CDN (xlsx, html5-qrcode, qrcodejs, chart.js, jspdf,
     html2canvas, mammoth, firebase compat...): "network-first, cache
     làm dự phòng" khi cài đặt lần đầu, rồi cache lại (stale-while-
     revalidate) mỗi lần tải thành công -> đúng như mô tả trong README
     ("lần đầu cần Internet để tải thư viện, sau đó SW cache lại").
   - Firestore/Firebase API calls (auth, firestore, storage endpoints)
     KHÔNG cache — luôn để mạng xử lý, Firestore tự lo offline
     persistence riêng (đã bật ở app.js). Cache các request này có thể
     làm hỏng dữ liệu thời gian thực.

   Khi đổi APP_SHELL (thêm/bớt file) hoặc muốn ép người dùng nhận bản mới
   ngay, chỉ cần đổi CACHE_VERSION bên dưới. */

const CACHE_VERSION = "v10";
const APP_SHELL_CACHE = `ita-app-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `ita-runtime-${CACHE_VERSION}`;

const APP_SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "i18n.js",
  "employees.js",
  "logo.png",
  "manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Các domain KHÔNG bao giờ cache (Firebase/Firestore realtime + auth) —
// để mạng xử lý trực tiếp, tránh cache đè lên dữ liệu/API call.
const NEVER_CACHE_HOSTS = [
  "firestore.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "www.googleapis.com"
];

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return; // không đụng vào POST/PUT (ghi dữ liệu)

  const url = new URL(req.url);
  if (NEVER_CACHE_HOSTS.some(host => url.hostname === host)) return; // để browser tự fetch, không qua SW

  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // App shell nội bộ: cache-first, có mạng thì âm thầm cập nhật cache ở nền
    event.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req)
          .then(res => {
            if (res && res.ok) {
              const clone = res.clone();
              caches.open(APP_SHELL_CACHE).then(cache => cache.put(req, clone));
            }
            return res;
          })
          .catch(() => cached); // mất mạng -> dùng bản cache nếu có
        return cached || network;
      })
    );
  } else {
    // Thư viện CDN bên ngoài (xlsx, html5-qrcode, qrcodejs, chart.js,
    // jspdf, html2canvas, mammoth, firebase-*-compat.js...): network-first,
    // rơi về cache khi không có mạng; cache lại mỗi lần tải thành công.
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then(cache => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
