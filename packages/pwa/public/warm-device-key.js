// Opens the device-key database and closes it again, before the main bundle runs. A connect
// waits on the key, and IndexedDB's first open on a cold launch is slow to answer while the
// page is busy starting; once the database has been opened, the app's own open answers sooner.
// It must create nothing: on a first launch the upgrade is aborted, so the app makes the
// database (and its object store) itself. The name is DB in src/adapters/device-keys.ts.
(function () {
  try {
    var req = indexedDB.open('perch-device');
    req.onupgradeneeded = function () {
      req.transaction.abort();
    };
    req.onsuccess = function () {
      req.result.close();
    };
    req.onerror = function (event) {
      event.preventDefault();
    };
  } catch (err) {
    // The app's own load reports why IndexedDB is unavailable.
  }
})();
