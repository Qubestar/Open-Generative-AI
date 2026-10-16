import React, { useState, useEffect, useCallback } from 'react';

export default function PublisherQueuePanel({ channelId = null, currentVideoPath = null, onPublished = null }) {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  const [activePublishId, setActivePublishId] = useState(null);

  const isPublisherAvailable = typeof window !== 'undefined' && Boolean(window.publisher);

  const loadQueue = useCallback(async () => {
    if (!isPublisherAvailable || !window.publisher.listQueue) return;
    try {
      const res = await window.publisher.listQueue(channelId ? { channelId } : {});
      if (res && res.ok) {
        setQueue(res.queue || []);
      }
    } catch (err) {
      console.error('Failed to load publisher queue:', err);
    }
  }, [isPublisherAvailable, channelId]);

  useEffect(() => {
    loadQueue();
    const interval = setInterval(loadQueue, 5000);
    return () => clearInterval(interval);
  }, [loadQueue]);

  const handleCreateSession = async () => {
    if (!currentVideoPath) {
      setStatusMessage({ type: 'error', text: 'Brak wyrenderowanego pliku wideo do opublikowania.' });
      return;
    }
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await window.publisher.createSession({
        channelId: channelId || 'default_channel',
        videoPath: currentVideoPath,
        metadata: {
          title: `Vidmyo Project Video ${new Date().toLocaleDateString()}`,
          description: 'Utworzono automatycznie w Vidmyo V2.6 Creator Studio.',
          privacyStatus: 'private',
        },
      });

      if (res.ok) {
        setActivePublishId(res.record.id);
        setStatusMessage({ type: 'success', text: `Utworzono sesję publikacji: ${res.record.id}` });
        await loadQueue();
      } else {
        setStatusMessage({ type: 'error', text: res.error || 'Błąd tworzenia sesji publikacji' });
      }
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleTestMockUpload = async (publishId) => {
    setLoading(true);
    setStatusMessage({ type: 'info', text: 'Rozpoczynanie testu uploadu na lokalnym serwerze mock (bezpieczne offline)...' });
    try {
      // In offline mock test mode, invoke test-mock-upload
      const res = await window.publisher.testMockUpload({
        publishId,
        mockBaseUrl: 'http://127.0.0.1:0', // Handled by mock transport in bridge
      });

      if (res.ok) {
        setStatusMessage({ type: 'success', text: `Test uploadu mock zakończony pomyślnie! Remote ID: ${res.record.remoteVideoId}` });
        if (onPublished) onPublished(res.record);
        await loadQueue();
      } else if (res.cancelled || res.record?.state === 'cancelled') {
        setStatusMessage({ type: 'info', text: 'Upload anulowany — wpis w kolejce w stanie „Anulowano”.' });
        await loadQueue();
      } else {
        setStatusMessage({ type: 'error', text: res.error || 'Błąd testu mock uploadu' });
      }
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handlePoll = async (publishId) => {
    setLoading(true);
    try {
      const res = await window.publisher.poll(publishId);
      if (res.ok) {
        setStatusMessage({ type: 'info', text: `Status zaktualizowany: ${res.record.state}` });
        await loadQueue();
      } else {
        setStatusMessage({ type: 'error', text: res.error || 'Błąd odpytywania statusu' });
      }
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (publishId) => {
    try {
      await window.publisher.retry(publishId);
      await loadQueue();
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    }
  };

  const handleCancel = async (publishId) => {
    try {
      await window.publisher.cancel(publishId);
      await loadQueue();
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    }
  };

  const getStatusBadge = (state) => {
    switch (state) {
      case 'published':
        return <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-300 font-medium">Opublikowano</span>;
      case 'processing':
        return <span className="px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-300 font-medium animate-pulse">Przetwarzanie YouTube</span>;
      case 'uploading':
        return <span className="px-2 py-0.5 rounded text-xs bg-purple-500/20 text-purple-300 font-medium animate-pulse">Wysyłanie chunks</span>;
      case 'scheduled':
        return <span className="px-2 py-0.5 rounded text-xs bg-amber-500/20 text-amber-300 font-medium">Zaplanowano</span>;
      case 'cancelled':
        return <span className="px-2 py-0.5 rounded text-xs bg-zinc-600/60 text-zinc-300 font-medium">Anulowano</span>;
      case 'error':
        return <span className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-300 font-medium">Błąd</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-xs bg-zinc-700 text-zinc-300 font-medium">W kolejce</span>;
    }
  };

  return (
    <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 my-4 text-zinc-100 shadow-xl">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-3">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
            Auto-Publisher — Kolejka Publikacji & Odporność na Restarty
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Zarządzanie sesjami publikacji YouTube, odporność na restarty i weryfikacja offline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {currentVideoPath && (
            <button
              onClick={handleCreateSession}
              disabled={loading}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition disabled:opacity-50"
            >
              Kolejkuj obecny film
            </button>
          )}
          <button
            onClick={loadQueue}
            className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs transition"
            title="Odśwież kolejkę"
          >
            Odśwież
          </button>
        </div>
      </div>

      {statusMessage && (
        <div
          className={`p-2.5 rounded-lg mb-3 text-xs ${
            statusMessage.type === 'error'
              ? 'bg-red-500/10 border border-red-500/30 text-red-300'
              : statusMessage.type === 'info'
              ? 'bg-blue-500/10 border border-blue-500/30 text-blue-300'
              : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {/* Queue items */}
      {queue.length === 0 ? (
        <div className="text-center py-6 text-xs text-zinc-500 border border-dashed border-zinc-800 rounded-lg">
          Kolejka publikacji jest pusta. Wyrenderuj wideo i dodaj do kolejki, aby rozpocząć.
        </div>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {queue.map((item) => (
            <div
              key={item.id}
              className="p-3 bg-zinc-950/60 border border-zinc-800/80 rounded-lg flex items-center justify-between text-xs hover:border-zinc-700 transition"
            >
              <div className="space-y-1 max-w-[60%]">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-200 truncate">{item.metadata?.title || item.id}</span>
                  {getStatusBadge(item.state)}
                </div>
                <div className="text-[11px] text-zinc-400 flex items-center gap-3">
                  <span>Plik: {item.videoPath ? item.videoPath.split('/').pop() : 'Brak ścieżki'}</span>
                  {item.remoteVideoId && (
                    <span className="text-emerald-400 font-mono">ID: {item.remoteVideoId}</span>
                  )}
                  <span>Utworzono: {new Date(item.createdAt).toLocaleTimeString()}</span>
                </div>
                {item.error && (
                  <div className="text-[11px] text-red-400 bg-red-950/30 px-2 py-0.5 rounded border border-red-900/30">
                    {item.error}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {item.state === 'queued' && (
                  <button
                    onClick={() => handleTestMockUpload(item.id)}
                    disabled={loading}
                    className="px-2.5 py-1 bg-purple-600/80 hover:bg-purple-600 text-white rounded text-xs transition"
                  >
                    Test Mock Upload
                  </button>
                )}
                {item.state === 'processing' && (
                  <button
                    onClick={() => handlePoll(item.id)}
                    disabled={loading}
                    className="px-2.5 py-1 bg-blue-600/80 hover:bg-blue-600 text-white rounded text-xs transition"
                  >
                    Odpytaj status
                  </button>
                )}
                {['error', 'cancelled'].includes(item.state) && (
                  <button
                    onClick={() => handleRetry(item.id)}
                    disabled={loading}
                    className="px-2.5 py-1 bg-amber-600/80 hover:bg-amber-600 text-white rounded text-xs transition"
                  >
                    Ponów
                  </button>
                )}
                {['queued', 'uploading'].includes(item.state) && (
                  <button
                    onClick={() => handleCancel(item.id)}
                    disabled={loading}
                    className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-red-300 rounded text-xs transition"
                  >
                    Anuluj
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Safety Notice */}
      <div className="mt-3 pt-2.5 border-t border-zinc-800/80 text-[11px] text-zinc-500 flex items-center justify-between">
        <span>Tryb bezpieczeństwa: publikacja produkcyjna wymaga zatwierdzenia Google OAuth App Review.</span>
        <span className="text-zinc-400">Offline Mock Engine: Aktywny</span>
      </div>
    </div>
  );
}
