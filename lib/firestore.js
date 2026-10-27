const crypto = require('crypto');

/**
 * 경량 Firestore REST API 클라이언트
 * - 무거운 firebase-admin SDK (60MB+, 5,700+ 파일) 대체
 * - Node.js 표준 내장 모듈(crypto, fetch)만 사용하여 0개 외부 의존성
 * - Google Cloud Service Account 표준 OAuth2 JWT 인증 지원
 */

function toFirestore(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: val.length ? { values: val.map(toFirestore) } : {} };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFirestore(v);
    }
    return { mapValue: Object.keys(fields).length ? { fields } : {} };
  }
  return { stringValue: String(val) };
}

function fromFirestore(val) {
  if (!val || typeof val !== 'object') return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map(fromFirestore);
  }
  if ('mapValue' in val) {
    const obj = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      obj[k] = fromFirestore(v);
    }
    return obj;
  }
  return null;
}

function base64Url(str) {
  return Buffer.from(str).toString('base64url');
}

class FirestoreClient {
  constructor(serviceAccount) {
    this.projectId = serviceAccount.project_id;
    this.clientEmail = serviceAccount.client_email;
    this.privateKey = serviceAccount.private_key;
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  async getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    // 만료 5분 전까지 기존 토큰 재사용
    if (this.cachedToken && this.tokenExpiresAt > now + 300) {
      return this.cachedToken;
    }

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.clientEmail,
      sub: this.clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/datastore',
      iat: now,
      exp: now + 3600
    };

    const encHeader = base64Url(JSON.stringify(header));
    const encPayload = base64Url(JSON.stringify(payload));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${encHeader}.${encPayload}`);
    const signature = signer.sign(this.privateKey, 'base64url');
    const assertion = `${encHeader}.${encPayload}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Google OAuth2 인증 실패 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in || 3600);
    return this.cachedToken;
  }

  getDocumentUrl(collection = 'point_shop', docId = 'state') {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${collection}/${docId}`;
  }

  async get(collection = 'point_shop', docId = 'state') {
    const token = await this.getAccessToken();
    const url = this.getDocumentUrl(collection, docId);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 404) {
      return null; // 문서 없음
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Firestore 읽기 실패 (${res.status}): ${errText}`);
    }

    const json = await res.json();
    if (!json.fields) return {};
    return fromFirestore({ mapValue: { fields: json.fields } });
  }

  async set(data, collection = 'point_shop', docId = 'state') {
    const token = await this.getAccessToken();
    const url = this.getDocumentUrl(collection, docId);
    const encoded = toFirestore(data);
    const fields = encoded.mapValue ? (encoded.mapValue.fields || {}) : {};

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Firestore 저장 실패 (${res.status}): ${errText}`);
    }

    return await res.json();
  }
}

module.exports = { FirestoreClient };
