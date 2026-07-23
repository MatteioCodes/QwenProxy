// Image upload for vision requests.
//
// chat.qwen.ai stores attachments in Alibaba OSS. The flow is:
//   1. POST /api/v2/files/getstsToken -> temporary OSS STS credentials + a
//      pre-assigned object path / file id.
//   2. PUT the bytes to OSS, signed with OSS4-HMAC-SHA256 (implemented here; no
//      external OSS SDK needed).
//   3. Reference the returned file url + id in the chat message's `files` array.

import { createHmac, createHash, randomUUID } from "node:crypto";

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

// Turn an OpenAI image_url value into raw bytes + mime type.
// Accepts data URLs (base64) and http(s) URLs.
export async function fetchImageBytes(imageUrl) {
  if (typeof imageUrl !== "string") throw new Error("image_url must be a string");
  const dataMatch = imageUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (dataMatch) {
    const mime = dataMatch[1] || "image/png";
    const isBase64 = Boolean(dataMatch[2]);
    const bytes = isBase64
      ? Buffer.from(dataMatch[3], "base64")
      : Buffer.from(decodeURIComponent(dataMatch[3]), "utf8");
    return { bytes, mime };
  }
  if (/^https?:\/\//.test(imageUrl)) {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`could not fetch image (${res.status})`);
    const mime = res.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, mime: mime.split(";")[0] };
  }
  throw new Error("unsupported image_url (expected data: or http(s) URL)");
}

function extFromMime(mime) {
  const map = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  return map[mime] || "png";
}

// PUT bytes to OSS using STS creds, signed with OSS4-HMAC-SHA256.
async function ossPut(sts, bytes, contentType) {
  const region = sts.region.replace(/^oss-/, ""); // oss-ap-southeast-1 -> ap-southeast-1
  const host = `${sts.bucketname}.${sts.endpoint}`;
  const objectKey = sts.file_path;

  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const iso = `${date}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  const scope = `${date}/${region}/oss/aliyun_v4_request`;
  const payloadHash = "UNSIGNED-PAYLOAD";

  const signed = {
    "content-type": contentType,
    host,
    "x-oss-content-sha256": payloadHash,
    "x-oss-date": iso,
    "x-oss-security-token": sts.security_token,
  };
  const canonicalHeaders = Object.keys(signed).sort().map((k) => `${k}:${signed[k]}\n`).join("");
  const canonicalRequest = [
    "PUT",
    "/" + sts.bucketname + "/" + encodeKey(objectKey),
    "",
    canonicalHeaders,
    "host",
    payloadHash,
  ].join("\n");
  const stringToSign = ["OSS4-HMAC-SHA256", iso, scope, sha256hex(canonicalRequest)].join("\n");

  let key = hmac("aliyun_v4" + sts.access_key_secret, date);
  key = hmac(key, region);
  key = hmac(key, "oss");
  key = hmac(key, "aliyun_v4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  const authorization =
    `OSS4-HMAC-SHA256 Credential=${sts.access_key_id}/${scope},` +
    `AdditionalHeaders=host,Signature=${signature}`;

  const res = await fetch(`https://${host}/${encodeKey(objectKey)}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-oss-content-sha256": payloadHash,
      "x-oss-date": iso,
      "x-oss-security-token": sts.security_token,
      Authorization: authorization,
    },
    body: bytes,
  });
  if (res.status !== 200) {
    throw new Error(`OSS upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

// Upload one image and return the message `files` entry that references it.
// `headers` is the shared qwenHeaders() function; `base` is the Qwen API origin.
export async function uploadImage(headers, base, bytes, mime) {
  const filename = `image-${randomUUID().slice(0, 8)}.${extFromMime(mime)}`;
  const res = await fetch(`${base}/api/v2/files/getstsToken`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ filename, filesize: bytes.length, filetype: "image" }),
  });
  const j = await res.json().catch(() => ({}));
  const sts = j?.data;
  if (!sts?.file_url) throw new Error(`getstsToken failed: ${JSON.stringify(j).slice(0, 200)}`);

  await ossPut(sts, bytes, mime);

  return {
    type: "image",
    file_type: mime,
    showType: "image",
    file_class: "vision",
    id: sts.file_id,
    url: sts.file_url,
    name: filename,
    size: bytes.length,
    status: "success",
    progress: 100,
    greenNet: "success",
    uploadTaskId: sts.file_id,
    itemId: randomUUID(),
  };
}
