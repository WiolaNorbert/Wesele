/*
 * Google Apps Script – backend strony weselnej.
 *
 * Upload:
 *
 *   małe pliki <= 5 MB
 *       Browser
 *          ↓ Base64
 *       Apps Script
 *          ↓ binary
 *       Google Drive
 *
 *   duże pliki > 5 MB
 *       Browser
 *          ↓ start
 *       Apps Script
 *          ↓ tworzy sesję Drive
 *       Browser
 *          ↓ Base64 chunk
 *       Apps Script
 *          ↓ binary chunk
 *       Google Drive
 *
 * Dzięki temu Google Drive nigdy nie jest wywoływany
 * bezpośrednio z przeglądarki, więc nie występuje problem CORS.
 */

const FOLDER_ID =
  "1yrbSrPSwL-zWC9p_kCvhzzShsH-VE_0U";


/*
 * Maksymalny rozmiar pojedynczego pliku.
 */
const MAX_FILE_SIZE =
  50 * 1024 * 1024;


/*
 * Pliki do tego rozmiaru są przesyłane jednym requestem.
 *
 * 5 MB po zakodowaniu Base64 daje około 6.7 MB danych.
 */
const SMALL_FILE_LIMIT =
  5 * 1024 * 1024;


/*
 * Rozmiar chunka.
 *
 * 8 MB jest wielokrotnością 256 KiB,
 * czego wymaga Google Drive resumable upload.
 */
const CHUNK_SIZE =
  8 * 1024 * 1024;


/*
 * ============================================================
 * POST
 * ============================================================
 */

function doPost(e) {

  try {

    const body =
      JSON.parse(
        e.postData.contents || "{}"
      );


    const action =
      body.action;


    if (action === "smallUpload") {
      return handleSmallUpload(body);
    }


    if (action === "start") {
      return handleStartUpload(body);
    }


    if (action === "chunk") {
      return handleChunkUpload(body);
    }


    throw new Error(
      "Unknown action: " + action
    );


  } catch (err) {

    return json({
      ok: false,

      error:
        String(
          err &&
          err.message
            ? err.message
            : err
        )
    });
  }
}


/*
 * ============================================================
 * MAŁY PLIK
 * ============================================================
 *
 * Jeden request:
 *
 * Browser
 *   ↓ Base64
 * Apps Script
 *   ↓ blob
 * DriveApp
 */

function handleSmallUpload(body) {

  if (!body.name) {
    throw new Error(
      "Brak nazwy pliku."
    );
  }


  if (!body.data) {
    throw new Error(
      "Brak danych pliku."
    );
  }


  const mimeType =
    body.mimeType ||
    "application/octet-stream";


  const bytes =
    Utilities.base64Decode(
      body.data
    );


  if (bytes.length > MAX_FILE_SIZE) {

    throw new Error(
      "Plik jest za duży. Maksymalny rozmiar to 50 MB."
    );
  }


  const blob =
    Utilities.newBlob(
      bytes,
      mimeType,
      String(body.name)
    );


  const folder =
    DriveApp.getFolderById(
      FOLDER_ID
    );


  const file =
    folder.createFile(blob);


  return json({

    ok: true,

    mode: "small",

    id: file.getId(),

    name: file.getName(),

    size: bytes.length

  });
}


/*
 * ============================================================
 * START DUŻEGO UPLOADU
 * ============================================================
 *
 * Apps Script tworzy sesję resumable upload.
 *
 * Nie przesyłamy tutaj zawartości pliku.
 */

function handleStartUpload(body) {

  if (!body.name) {

    throw new Error(
      "Brak nazwy pliku."
    );
  }


  const size =
    Number(body.size);


  if (
    !Number.isFinite(size) ||
    size <= 0
  ) {

    throw new Error(
      "Nieprawidłowy rozmiar pliku."
    );
  }


  if (size > MAX_FILE_SIZE) {

    throw new Error(
      "Plik jest za duży. Maksymalny rozmiar to 50 MB."
    );
  }


  const mimeType =
    body.mimeType ||
    "application/octet-stream";


  const metadata = {

    name:
      String(body.name),

    mimeType:
      mimeType,

    parents:
      [FOLDER_ID]

  };


  const token =
    ScriptApp.getOAuthToken();


  const url =
    "https://www.googleapis.com/upload/drive/v3/files" +
    "?uploadType=resumable" +
    "&supportsAllDrives=true";


  const response =
    UrlFetchApp.fetch(
      url,
      {

        method: "post",

        contentType:
          "application/json; charset=UTF-8",

        headers: {
          Authorization:
            "Bearer " + token
        },

        payload:
          JSON.stringify(metadata),

        muteHttpExceptions:
          true

      }
    );


  const code =
    response.getResponseCode();


  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Drive session error " +
      code +
      ": " +
      response.getContentText()
    );
  }


  /*
   * Google Drive zwraca URL sesji
   * w nagłówku Location.
   */
  const headers =
    response.getAllHeaders();


  let session = null;


  for (const key in headers) {

    if (
      String(key).toLowerCase() ===
      "location"
    ) {

      session =
        headers[key];

      break;
    }
  }


  if (Array.isArray(session)) {
    session = session[0];
  }


  if (!session) {

    throw new Error(
      "Google Drive nie zwrócił URL sesji uploadu."
    );
  }


  return json({

    ok: true,

    session:
      String(session),

    chunkSize:
      CHUNK_SIZE

  });
}


/*
 * ============================================================
 * CHUNK DUŻEGO PLIKU
 * ============================================================
 *
 * Browser wysyła:
 *
 * {
 *   action: "chunk",
 *   session: "...",
 *   offset: 0,
 *   total: 15000000,
 *   data: "BASE64..."
 * }
 *
 * Apps Script:
 *
 * Base64 → binary → Google Drive
 */

function handleChunkUpload(body) {

  if (!body.session) {

    throw new Error(
      "Brak URL sesji uploadu."
    );
  }


  const offset =
    Number(body.offset);


  const total =
    Number(body.total);


  if (
    !Number.isFinite(offset) ||
    offset < 0
  ) {

    throw new Error(
      "Nieprawidłowy offset."
    );
  }


  if (
    !Number.isFinite(total) ||
    total <= 0
  ) {

    throw new Error(
      "Nieprawidłowy rozmiar pliku."
    );
  }


  if (total > MAX_FILE_SIZE) {

    throw new Error(
      "Plik jest za duży. Maksymalny rozmiar to 50 MB."
    );
  }


  if (!body.data) {

    throw new Error(
      "Brak danych chunka."
    );
  }


  /*
   * Dekodowanie tylko aktualnego chunka.
   */
  const bytes =
    Utilities.base64Decode(
      body.data
    );


  const length =
    bytes.length;


  if (length <= 0) {

    throw new Error(
      "Pusty chunk."
    );
  }


  const end =
    offset +
    length -
    1;


  if (end >= total) {

    throw new Error(
      "Chunk wykracza poza rozmiar pliku."
    );
  }


  /*
   * Przekazujemy chunk bezpośrednio do Google Drive.
   */
  const response =
    UrlFetchApp.fetch(
      body.session,
      {

        method: "put",

        contentType:
          "application/octet-stream",

        headers: {

          "Content-Range":
            "bytes " +
            offset +
            "-" +
            end +
            "/" +
            total

        },

        payload:
          bytes,

        muteHttpExceptions:
          true

      }
    );


  const code =
    response.getResponseCode();


  /*
   * 308 = chunk przyjęty,
   * upload jeszcze trwa.
   *
   * 200/201 = cały plik gotowy.
   */
  if (
    code !== 200 &&
    code !== 201 &&
    code !== 308
  ) {

    throw new Error(
      "Drive chunk error " +
      code +
      ": " +
      response.getContentText()
    );
  }


  return json({

    ok: true,

    status:
      code,

    uploaded:
      offset + length,

    total:
      total

  });
}


/*
 * ============================================================
 * GET
 * ============================================================
 */

function doGet(e) {

  const action =
    e.parameter &&
    e.parameter.action;


  /*
   * Diagnostyka wersji.
   */
  if (action === "version") {

    return json({

      ok: true,

      version:
        "wedding-upload-final-v1"

    });
  }


  /*
   * Galeria.
   */
  if (action === "gallery") {

    try {

      return json({

        ok: true,

        items:
          listRecentImages()

      });

    } catch (err) {

      return json({

        ok: false,

        error:
          String(
            err &&
            err.message
              ? err.message
              : err
          )

      });
    }
  }


  return ContentService.createTextOutput(
    "Wedding upload API OK"
  );
}


/*
 * ============================================================
 * GALERIA
 * ============================================================
 */

function listRecentImages() {

  const folder =
    DriveApp.getFolderById(
      FOLDER_ID
    );


  const files =
    folder.getFiles();


  const items = [];


  while (files.hasNext()) {

    const file =
      files.next();


    if (
      file
        .getMimeType()
        .indexOf("image/") === 0
    ) {

      items.push({

        id:
          file.getId(),

        name:
          file.getName(),

        created:
          file
            .getDateCreated()
            .getTime()

      });
    }
  }


  items.sort(
    function(a, b) {
      return b.created - a.created;
    }
  );


  return items.slice(0, 10);
}


/*
 * ============================================================
 * JSON
 * ============================================================
 */

function json(data) {

  return ContentService
    .createTextOutput(
      JSON.stringify(data)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}