import type { AuthUser, RecordDetail, WorklistRow } from './types';

const TOKEN_KEY = 'cockpit.token';

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setToken = (token: string | null) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing — the session simply will not persist across reloads */
  }
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    override readonly message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`/api${path}`, { ...init, headers });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.message ?? res.statusText, err.code ?? 'ERROR', err.details);
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ user: AuthUser }>('/auth/me'),

  health: () => request<{ ok: boolean; checks: Record<string, { ok: boolean; error?: string }> }>('/health'),

  list: (params: { status?: string; q?: string; mine?: boolean }) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.q) qs.set('q', params.q);
    if (params.mine) qs.set('mine', 'true');
    return request<{ rows: WorklistRow[]; total: number }>(`/records?${qs}`);
  },

  counts: () => request<Record<string, number>>('/records/counts'),

  detail: (id: string) => request<RecordDetail>(`/records/${id}`),

  upload: (file: File, vendorHint?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (vendorHint) form.append('vendorHint', vendorHint);
    return request<{ record: { id: string }; duplicates: unknown[] }>('/records', {
      method: 'POST',
      body: form,
    });
  },

  publish: (id: string, overrideReason?: string) =>
    request<RecordDetail>(`/records/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ overrideReason }),
    }),

  updateFields: (id: string, updates: unknown) =>
    request<RecordDetail>(`/records/${id}/fields`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  addLine: (id: string) => request<RecordDetail>(`/records/${id}/lines`, { method: 'POST' }),

  deleteLine: (id: string, lineNumber: number) =>
    request<RecordDetail>(`/records/${id}/lines/${lineNumber}`, { method: 'DELETE' }),

  acknowledge: (id: string, code: string, fieldPath: string) =>
    request<RecordDetail>(`/records/${id}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ code, fieldPath }),
    }),

  approve: (id: string) => request<RecordDetail>(`/records/${id}/approve`, { method: 'POST' }),

  reject: (id: string, reason: string) =>
    request<RecordDetail>(`/records/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  resubmit: (id: string) => request<RecordDetail>(`/records/${id}/resubmit`, { method: 'POST' }),

  retryExtraction: (id: string) =>
    request<RecordDetail>(`/records/${id}/retry-extraction`, { method: 'POST' }),

  manualEntry: (id: string) => request<RecordDetail>(`/records/${id}/manual-entry`, { method: 'POST' }),

  cancel: (id: string, reason?: string) =>
    request<RecordDetail>(`/records/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  deleteDraft: (id: string) => request<void>(`/records/${id}`, { method: 'DELETE' }),

  /** The PDF is behind auth, so it is fetched as a blob rather than linked directly. */
  documentUrl: async (id: string) => {
    const res = await fetch(`/api/records/${id}/document`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    });
    if (!res.ok) {
      let message = 'Could not load the PDF.';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) message = body.error.message;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      throw new ApiError(res.status, message, 'PDF_ERROR');
    }
    return URL.createObjectURL(await res.blob());
  },
};
