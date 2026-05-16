import { getAllProviders, getProviderById } from 'studio/src/providers.js';
import { NextResponse } from 'next/server';

// Generic provider proxy — forwards requests to external APIs (OpenAI, Claude, xAI, etc.)
// and handles auth header injection so the browser never sends keys directly.

export async function GET(request, { params }) {
    return handleProxy(request, params, 'GET');
}

export async function POST(request, { params }) {
    return handleProxy(request, params, 'POST');
}

export async function PUT(request, { params }) {
    return handleProxy(request, params, 'PUT');
}

export async function DELETE(request, { params }) {
    return handleProxy(request, params, 'DELETE');
}

async function handleProxy(request, params, method) {
    const providerId = params.provider;
    const pathSegments = params.path || [];
    const provider = getProviderById(providerId);

    if (!provider || provider.id === 'muapi') {
        return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
    }

    // Read provider key: header first, then cookie fallback
    const headerKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace('Bearer ', '').trim();
    const cookieKey = request.cookies.get(`vidmyo_key_${providerId}`)?.value || request.cookies.get('muapi_key')?.value;
    const apiKey = headerKey || cookieKey;

    if (!apiKey) {
        return NextResponse.json({ error: `Missing ${provider.name} API key` }, { status: 401 });
    }

    const upstreamPath = pathSegments.join('/');
    let url = `${provider.baseUrl.replace(/\/$/, '')}/${upstreamPath}`;

    // Append query-string auth if required (e.g. Google Gemini)
    if (provider.authInQuery) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}${provider.authHeader}=${encodeURIComponent(apiKey)}`;
    }

    // Clone headers
    const headers = new Headers();
    request.headers.forEach((value, key) => {
        if (['host', 'connection', 'content-length'].includes(key)) return;
        headers.set(key, value);
    });

    if (!provider.authInQuery) {
        const value = provider.authPrefix ? `${provider.authPrefix}${apiKey}` : apiKey;
        headers.set(provider.authHeader, value);
    }

    let body;
    if (method !== 'GET' && method !== 'HEAD') {
        try {
            body = await request.arrayBuffer();
        } catch { /* no body */ }
    }

    try {
        const resp = await fetch(url, { method, headers, ...(body ? { body } : {}) });
        const data = await resp.arrayBuffer();
        return new NextResponse(data, {
            status: resp.status,
            headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
        });
    } catch (err) {
        console.error(`[proxy/${providerId}] error:`, err);
        return NextResponse.json({ error: 'Upstream error' }, { status: 502 });
    }
}
