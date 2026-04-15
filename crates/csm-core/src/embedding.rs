use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

pub const MODEL: EmbeddingModel = EmbeddingModel::MultilingualE5Large;
pub const MODEL_LABEL: &str = "intfloat/multilingual-e5-large";
pub const EMBEDDING_DIM: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ModelStatus {
    Idle,
    Loading,
    Ready,
    Failed { message: String },
}

pub struct EmbeddingEngine {
    cache_dir: PathBuf,
    model: RwLock<Option<TextEmbedding>>,
    status: RwLock<ModelStatus>,
}

impl EmbeddingEngine {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            model: RwLock::new(None),
            status: RwLock::new(ModelStatus::Idle),
        }
    }

    pub fn status(&self) -> ModelStatus {
        self.status.read().unwrap().clone()
    }

    /// fastembed のキャッシュレイアウトに依存せず「何かしら DL 済みと思しきか」を
    /// 粗く判定する。厳密な整合性は ensure_model 側に任せる。
    pub fn is_cached(&self) -> bool {
        std::fs::read_dir(&self.cache_dir)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
    }

    /// モデルをロード（未 DL なら HF から取得）。ブロッキング処理なので
    /// Tauri コマンド側では spawn_blocking で包むこと。
    pub fn ensure_model(&self) -> Result<(), String> {
        if self.model.read().unwrap().is_some() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.cache_dir).map_err(|e| e.to_string())?;
        *self.status.write().unwrap() = ModelStatus::Loading;
        let options = InitOptions::new(MODEL)
            .with_cache_dir(self.cache_dir.clone())
            .with_show_download_progress(true);
        match TextEmbedding::try_new(options) {
            Ok(m) => {
                *self.model.write().unwrap() = Some(m);
                *self.status.write().unwrap() = ModelStatus::Ready;
                Ok(())
            }
            Err(e) => {
                let msg = e.to_string();
                *self.status.write().unwrap() = ModelStatus::Failed {
                    message: msg.clone(),
                };
                Err(msg)
            }
        }
    }

    pub fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        self.ensure_model()?;
        let mut guard = self.model.write().unwrap();
        let model = guard.as_mut().ok_or("embedding model not loaded")?;
        model.embed(texts, None).map_err(|e| e.to_string())
    }
}
