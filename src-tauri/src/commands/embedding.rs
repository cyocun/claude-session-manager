use csm_core::embedding::{EmbeddingEngine, ModelStatus};
use std::sync::Arc;

#[tauri::command]
pub fn get_embedding_model_status(
    state: tauri::State<'_, Arc<EmbeddingEngine>>,
) -> ModelStatus {
    state.status()
}

#[tauri::command]
pub fn is_embedding_model_cached(state: tauri::State<'_, Arc<EmbeddingEngine>>) -> bool {
    state.is_cached()
}

#[tauri::command]
pub async fn download_embedding_model(
    state: tauri::State<'_, Arc<EmbeddingEngine>>,
) -> Result<(), String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.ensure_model())
        .await
        .map_err(|e| e.to_string())?
}
