// ベクトル索引の状態表示 + 構築トリガーの最小 UI。
// 検索 pane の grid 構造には手を入れず、body 右下にフローティングで差し込む。
// Phase D2 で検索バー周辺に正式に組み込む予定。

import { createEl } from './dom.js';
import type { EmbeddingModelStatus, VectorIndexStatus } from './types.js';

export type VectorIndexControlsDeps = {
  t: (key: string) => string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  onToast?: (msg: string) => void;
};

export function createVectorIndexControls(deps: VectorIndexControlsDeps) {
  const { t, invoke, onToast } = deps;

  const wrap = createEl('div', { className: 'vector-index-controls' });
  wrap.style.cssText = [
    'position:fixed',
    'bottom:10px',
    'right:10px',
    'z-index:50',
    'background:var(--bg-surface)',
    'border:0.5px solid var(--border)',
    'border-radius:8px',
    'padding:6px 10px',
    'font-size:11px',
    'color:var(--text-secondary)',
    'display:flex',
    'align-items:center',
    'gap:8px',
    'box-shadow:0 2px 8px rgba(0,0,0,.12)',
  ].join(';');

  const label = createEl('span', { textContent: t('vectorIndexIdle') });
  const btn = createEl('button', {
    textContent: t('vectorIndexBuildAction'),
    onClick: () => void triggerBuild(),
  }) as HTMLButtonElement;
  btn.style.cssText = [
    'font-size:11px',
    'padding:3px 8px',
    'border-radius:6px',
    'border:0.5px solid var(--border)',
    'background:var(--bg)',
    'color:var(--text)',
    'cursor:pointer',
  ].join(';');

  wrap.append(label, btn);

  let polling: number | null = null;

  async function refresh(): Promise<void> {
    const [indexStatus, cached] = await Promise.all([
      invoke('get_vector_index_status') as Promise<VectorIndexStatus | null>,
      invoke('is_embedding_model_cached') as Promise<boolean | null>,
    ]);

    if (indexStatus?.isIndexing) {
      label.textContent = t('vectorIndexBuilding');
      btn.disabled = true;
      btn.style.opacity = '0.5';
      return;
    }
    btn.disabled = false;
    btn.style.opacity = '1';

    if (indexStatus && indexStatus.chunkCount > 0) {
      label.textContent = t('vectorIndexReadyWithCount').replace('{n}', String(indexStatus.chunkCount));
      btn.textContent = t('vectorIndexBuildAction');
    } else if (!cached) {
      label.textContent = t('vectorIndexIdle');
      btn.textContent = t('vectorIndexDownloadModel');
    } else {
      label.textContent = t('vectorIndexIdle');
      btn.textContent = t('vectorIndexBuildAction');
    }
  }

  async function triggerBuild(): Promise<void> {
    const cached = (await invoke('is_embedding_model_cached')) as boolean | null;
    const confirmKey = cached ? 'vectorIndexBuildConfirm' : 'vectorIndexDownloadConfirm';
    if (!window.confirm(t(confirmKey))) return;

    btn.disabled = true;
    btn.style.opacity = '0.5';
    label.textContent = t('vectorIndexBuilding');
    try {
      // build_vector_index は内部で初回 DL も走らせる (ensure_model 経由)。
      await invoke('build_vector_index');
      if (onToast) onToast(t('vectorIndexBuildDone'));
    } catch (e) {
      console.error('[vector-index] build failed', e);
      if (onToast) onToast(t('vectorIndexBuildFailed'));
    } finally {
      await refresh();
    }
  }

  function mount(): void {
    document.body.appendChild(wrap);
    void refresh();
    // 構築中の状態を反映するため軽くポーリング。build 完了後は refresh で
    // 安定状態に落ち着くので過剰更新にはならない。
    polling = window.setInterval(() => void refresh(), 2000);
  }

  function unmount(): void {
    wrap.remove();
    if (polling !== null) {
      window.clearInterval(polling);
      polling = null;
    }
  }

  // `EmbeddingModelStatus` は現状参照していないが、Phase D2 でローディング中
  // 表示などに使う予定なので import を保持。
  void (null as unknown as EmbeddingModelStatus);

  return { mount, unmount, refresh };
}
