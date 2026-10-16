'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { VfxStudio, StoryStudio, AnimationsStudio, ChannelsStudio, RepurposeStudio, CleanerStudio, LipSyncStudio, CinemaStudio, MarketingStudio, WorkflowStudio, SettingsModal, CloudImageStudio, CloudVideoStudio, LocalAgentsStudio, PromoReviewStudio, CartoonStudio, AutoEditorPanel, PublisherQueuePanel, ScreenStudio, TranslateStudio } from 'studio';
import axios from 'axios';
import styles from './StandaloneShell.module.css';
import { readAppearance, saveAppearance } from '../packages/studio/src/appearance.mjs';
import { BookOpen, FolderKanban, Scissors, Film, Image as ImageIcon, Video, Bot, Sparkles, MonitorPlay, Megaphone, CloudUpload, Languages } from 'lucide-react';

// Public navigation. Legacy studios retain their routes without occupying the workspace rail.
const TABS = [
  { id: 'channels', label: 'Channels' },
  { id: 'story', label: 'Stickman' },
  { id: 'animations', label: 'Animations' },
  { id: 'cleaner', label: 'Cleaner' },
  { id: 'repurpose', label: 'Clipper' },
  { id: 'translate', label: 'Translate' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'vfx', label: 'VFX' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'screen-studio', label: 'Screen Studio' },
  // Luke kept a Publish tab (2026-09-26); the queue is also shown in Cleaner → review.
  { id: 'publisher', label: 'Publish' },
  { id: 'agents', label: 'Agents' },
];

const STORAGE_KEY = 'vidmyo_cloud_key';

// Dev-only panel route (V2.6 Phase 3, item 5). The Marketing/Auto-Editor/
// Publisher screens are reachable in the product only through flows that need
// Electron or a real Cleaner project. In a development build they can be
// opened directly with ?panel=<id> so they can be verified in a browser.
// The block below is stripped from production builds by NODE_ENV.
const DEV_PANELS = {
  marketing: 'marketing',
  promo: 'promo',
  cartoon: 'cartoon',
  autoeditor: 'autoeditor',
  publisher: 'publisher',
  screenstudio: 'screenstudio',
};

function renderDevPanel(panel, dir) {
  if (panel === 'marketing') return <MarketingStudio />;
  if (panel === 'promo') return <PromoReviewStudio />;
  if (panel === 'cartoon') return <CartoonStudio />;
  if (panel === 'autoeditor') return <AutoEditorPanel projectDir={dir || null} />;
  if (panel === 'publisher') return <PublisherQueuePanel />;
  if (panel === 'screenstudio') return <ScreenStudio />;
  return null;
}
const TAB_ICONS = { channels: FolderKanban, story: BookOpen, animations: Film, cleaner: Scissors, repurpose: Film, translate: Languages, image: ImageIcon, video: Video, vfx: Sparkles, marketing: Megaphone, 'screen-studio': MonitorPlay, publisher: CloudUpload, agents: Bot };

export default function StandaloneShell() {
  const params = useParams();
  const router = useRouter();
  const slug = params?.slug || []; 
  const idFromParams = params?.id;
  const tabFromParams = params?.tab;

  // Helper to extract workflow details precisely from either route structure
  const getWorkflowInfo = useCallback(() => {
    if (idFromParams) {
        return { id: idFromParams, tab: tabFromParams || null };
    }
    const wfIndex = slug.findIndex(s => s === 'workflows' || s === 'workflow');
    if (wfIndex === -1) return { id: null, tab: null };
    return {
      id: slug[wfIndex + 1] || null,
      tab: slug[wfIndex + 2] || null
    };
  }, [slug, idFromParams, tabFromParams]);

  const { id: urlWorkflowId } = getWorkflowInfo();

  // Initialize activeTab from URL slug/params or default to 'image'
  const getInitialTab = () => {
    if (idFromParams || slug.includes('workflow')) return 'workflows';
    if (slug.includes('agents')) return 'agents';
    const firstSegment = slug[0];
    if (firstSegment && TABS.find(t => t.id === firstSegment)) return firstSegment;
    return 'channels';
  };
  
  const [apiKey, setApiKey] = useState(null);
  const [activeTab, setActiveTab] = useState(getInitialTab());
  const [devPanel, setDevPanel] = useState(null);
  const [devPanelDir, setDevPanelDir] = useState(null);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    let panel = null;
    let dir = null;
    try {
      const query = new URLSearchParams(window.location.search);
      panel = query.get('panel');
      dir = query.get('dir');
    } catch {
      panel = null;
    }
    if (panel && DEV_PANELS[panel]) {
      setDevPanel(panel);
      setDevPanelDir(dir);
    }
  }, []);
  const [imageVideoHandoff, setImageVideoHandoff] = useState(null);
  const [channelCreativeHandoff, setChannelCreativeHandoff] = useState(null);
  
  const [balance, setBalance] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const [hasMounted, setHasMounted] = useState(false);
  const [appearance, setAppearance] = useState('dark');
  useEffect(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* Private browser storage may be blocked. */ }
    setAppearance(readAppearance(storage));
  }, []);
  const changeAppearance = event => {
    let storage;
    try { storage = window.localStorage; } catch { /* Keep the in-memory selection. */ }
    setAppearance(saveAppearance(storage, event.target.value));
  };
  useEffect(() => { document.documentElement.dataset.appearance = appearance; }, [appearance]);

  // Drag and Drop State
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState(null);

  // Sync tab with URL if user navigates manually or via browser back/forward
  useEffect(() => {
    const info = getWorkflowInfo();
    if (info.id || slug.includes('workflow')) {
        setActiveTab('workflows');
    } else if (slug.includes('agents')) {
        setActiveTab('agents');
    } else {
        const firstSegment = slug[0];
        if (firstSegment && TABS.find(t => t.id === firstSegment)) {
          setActiveTab(firstSegment);
        } else {
          setActiveTab('channels');
        }
    }
  }, [slug, getWorkflowInfo]);

  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    router.push(`/studio/${tabId}`);
  };

  const handleUseImageInVideo = useCallback((handoff) => {
    setImageVideoHandoff(handoff);
    setActiveTab('video');
    router.push('/studio/video');
  }, [router]);

  const handleImageHandoffConsumed = useCallback(() => setImageVideoHandoff(null), []);
  const handleChannelCreative = useCallback((handoff) => {
    if (!handoff?.brief) return;
    const tab = handoff.section === 'animation' ? 'animations' : 'story';
    setChannelCreativeHandoff({ ...handoff, section: tab === 'animations' ? 'animation' : 'story' });
    setActiveTab(tab);
    router.push(`/studio/${tab}`);
  }, [router]);
  const handleChannelHandoffConsumed = useCallback(() => setChannelCreativeHandoff(null), []);

  // Auto-hide header when inside a specific workflow view
  useEffect(() => {
    const isEditingWorkflow = (activeTab === 'workflows' || !!idFromParams) && urlWorkflowId;
    if (isEditingWorkflow) {
      setIsHeaderVisible(false);
    } else {
      setIsHeaderVisible(true);
    }
  }, [activeTab, urlWorkflowId, idFromParams]);

  // Global builder CSS cleanup when switching away from Workflows tab
  useEffect(() => {
    const fromBuilder = sessionStorage.getItem("fromWorkflowBuilder");
    if (fromBuilder && activeTab !== 'workflows') {
      sessionStorage.removeItem("fromWorkflowBuilder");
      window.location.reload();
    }
  }, [activeTab]);

  const fetchBalance = useCallback(async () => {}, []);  // no cloud balance display

  useEffect(() => {
    setHasMounted(true);
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setApiKey(stored);
      fetchBalance(stored);
      // Sync cookie immediately on mount to establish identity for background requests
      document.cookie = `vidmyo_cloud_key=${stored}; path=/; max-age=31536000; SameSite=Lax`;
    }
  }, [fetchBalance]);

  const handleKeySave = useCallback((key) => {
    localStorage.setItem(STORAGE_KEY, key);
    setApiKey(key);
    fetchBalance(key);
    document.cookie = `vidmyo_cloud_key=${key}; path=/; max-age=31536000; SameSite=Lax`;
  }, [fetchBalance]);

  const handleKeyChange = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setApiKey(null);
    setBalance(null);
    document.cookie = "vidmyo_cloud_key=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  }, []);

  // Inject API key into all outgoing Axios requests (prop-based approach)
  // We use an interceptor to be selective and NOT send the key to external domains like S3
  useEffect(() => {
    // Safety: Clear any global defaults that might have been set previously
    delete axios.defaults.headers.common['x-api-key'];

    if (!apiKey) return;

    const interceptorId = axios.interceptors.request.use((config) => {
      // Check if URL is local/proxied
      const isRelative = config.url.startsWith('/') || !config.url.startsWith('http');
      const isInternalProxy = config.url.includes('/api/app') || config.url.includes('/api/workflow') || config.url.includes('/api/agents') || config.url.includes('/api/api') || config.url.includes('/api/v1');

      if (isRelative || isInternalProxy) {
        config.headers['x-api-key'] = apiKey;
      }
      
      return config;
    });

    return () => {
      axios.interceptors.request.eject(interceptorId);
    };
  }, [apiKey]);

  // Poll for balance every 30 seconds if key is present
  useEffect(() => {
    if (!apiKey) return;
    const interval = setInterval(() => fetchBalance(apiKey), 30000);
    return () => clearInterval(interval);
  }, [apiKey, fetchBalance]);

  // Drag and Drop Handlers
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeTab === 'repurpose' || activeTab === 'cleaner' || activeTab === 'vfx' || activeTab === 'translate') {
      setIsDragging(false);
      return;
    }
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, [activeTab]);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set to false if we're leaving the container itself, not moving between children
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (activeTab === 'repurpose' || activeTab === 'cleaner' || activeTab === 'vfx' || activeTab === 'translate') return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setDroppedFiles(files);
    }
  }, [activeTab]);

  const handleFilesHandled = useCallback(() => {
    setDroppedFiles(null);
  }, []);

  if (!hasMounted) return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center">
      <div className="animate-spin text-[#7c3aed] text-3xl">◌</div>
    </div>
  );

  // No API-key gate: the app opens keyless straight to Video Delta (free, local).
  // A cloud key is OPTIONAL and only needed by the cloud tabs.

  return (
    <div 
      className={`${styles.workspace} ${!isHeaderVisible ? styles.expanded : ''}`}
      data-appearance={appearance}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-[100] bg-[#7c3aed]/10 backdrop-blur-md border-4 border-dashed border-[#7c3aed]/50 flex items-center justify-center pointer-events-none transition-all duration-300">
          <div className="bg-[#0a0a0a] p-8 rounded-3xl border border-white/10 shadow-2xl flex flex-col items-center gap-4 scale-110 animate-pulse">
            <div className="w-20 h-20 bg-[#7c3aed] rounded-2xl flex items-center justify-center">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-xl font-bold text-white">Drop your media here</span>
              <span className="text-sm text-white/40">Images, videos, or audio files</span>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      {isHeaderVisible && (
        <header
          className={styles.rail}
          style={{ WebkitAppRegion: 'drag' }}  /* frameless Electron window: header = drag handle */
        >
          {/* Left: Logo */}
          <div className={styles.brand}>
            {/* Beat Wave mark — voiceover waveform meets the V */}
            <svg width="30" height="30" viewBox="0 0 512 512" aria-label="Vidmyo">
              <rect width="512" height="512" rx="115" fill="#17171B"/>
              <g stroke="#3ECF8E" strokeWidth="34" strokeLinecap="round">
                <line x1="98" y1="230" x2="98" y2="282"/>
                <line x1="152" y1="202" x2="152" y2="310"/>
                <line x1="206" y1="160" x2="206" y2="352"/>
              </g>
              <path d="M266 138 L342 374 L418 138" stroke="#FFFFFF" strokeWidth="50" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
            <span className={styles.brandName}>Vidmyo<span className={styles.brandCaption}>CREATOR STUDIO</span></span>
          </div>

          {/* Center: Navigation */}
          <nav aria-label="Studios" className={styles.navigation} style={{ WebkitAppRegion: 'no-drag' }}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                aria-current={activeTab === tab.id ? 'page' : undefined}
                className={`${styles.navItem} ${activeTab === tab.id ? styles.active : ''}`}
              >
                {(() => { const Icon = TAB_ICONS[tab.id]; return <Icon size={19} aria-hidden="true" />; })()}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>

          {/* Right: Actions */}
          <div className={styles.actions} style={{ WebkitAppRegion: 'no-drag' }}>
            <button
              onClick={() => setShowSettings(true)}
              title="Settings"
              className={styles.settings}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </button>
          </div>
        </header>
      )}

      {/* Studio Content */}
      <main className={styles.content} aria-label={`${TABS.find(tab => tab.id === activeTab)?.label || 'Studio'} workspace`}>
        {!devPanel && (
          <>
          {activeTab === 'channels' && <ChannelsStudio onOpenCreative={handleChannelCreative} />}
          {activeTab === 'image'   && <CloudImageStudio onUseInVideo={handleUseImageInVideo} />}
          {activeTab === 'video'   && <CloudVideoStudio imageHandoff={imageVideoHandoff} onImageHandoffConsumed={handleImageHandoffConsumed} />}
          {activeTab === 'story' && <StoryStudio initialHandoff={channelCreativeHandoff} onHandoffConsumed={handleChannelHandoffConsumed} onOpenSettings={() => setShowSettings(true)} onNavigateAgents={() => handleTabChange('agents')} />}
          {activeTab === 'animations' && <AnimationsStudio initialHandoff={channelCreativeHandoff} onHandoffConsumed={handleChannelHandoffConsumed} onOpenSettings={() => setShowSettings(true)} onNavigateAgents={() => handleTabChange('agents')} />}
          {activeTab === 'cleaner' && <CleanerStudio />}
          {activeTab === 'vfx' && <VfxStudio onOpenSettings={() => setShowSettings(true)} />}
          {activeTab === 'repurpose' && <RepurposeStudio />}
          {activeTab === 'translate' && <TranslateStudio />}
          {activeTab === 'lipsync' && <LipSyncStudio apiKey={apiKey} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
          {activeTab === 'cinema'  && <CinemaStudio  apiKey={apiKey} />}
          {activeTab === 'marketing' && <MarketingStudio apiKey={apiKey} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
          {activeTab === 'screen-studio' && <ScreenStudio />}
          {activeTab === 'publisher' && <PublisherQueuePanel />}
          {activeTab === 'workflows' && <WorkflowStudio apiKey={apiKey} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />}
          {activeTab === 'agents' && <LocalAgentsStudio />}
          </>
        )}
        {devPanel && renderDevPanel(devPanel, devPanelDir)}
      </main>

      {/* Settings Modal — provider keys over the canonical @vidmyo/core catalog */}
      {showSettings && (
        <SettingsModal
          appearance={appearance}
          onAppearanceChange={changeAppearance}
          onClose={() => setShowSettings(false)}
          onCloudKeyChange={(key) => (key ? handleKeySave(key) : handleKeyChange())}
        />
      )}
    </div>
  );
}
