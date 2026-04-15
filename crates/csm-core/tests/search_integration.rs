//! BM25 / Tantivy 検索の回帰テスト。
//!
//! `CLAUDE_DATA_DIR` にフィクスチャを指すよう一度だけ設定し、
//! 以降のテストはすべて同じ fixture を共有する
//! (sessions.rs の `find_session_file` 内のグローバルキャッシュを汚さないため)。

use std::path::PathBuf;
use std::sync::Once;

use csm_core::models::SearchSort;
use csm_core::search::SearchIndex;
use tempfile::TempDir;

static INIT: Once = Once::new();

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-data")
}

fn ensure_env() {
    INIT.call_once(|| {
        std::env::set_var("CLAUDE_DATA_DIR", fixture_dir());
    });
}

fn fresh_index() -> (SearchIndex, TempDir) {
    ensure_env();
    let tmp = tempfile::tempdir().expect("tempdir");
    let index = SearchIndex::new(tmp.path().to_path_buf()).expect("create index");
    index.build_full_index().expect("build index");
    // Tantivy reader uses ReloadPolicy::OnCommitWithDelay — give it a beat so
    // the segments committed above become visible before we query.
    std::thread::sleep(std::time::Duration::from_millis(500));
    (index, tmp)
}

#[test]
fn finds_tauri_build_session() {
    let (idx, _tmp) = fresh_index();
    let hits = idx
        .search(
            "Tauri ビルド",
            None,
            10,
            None,
            None,
            SearchSort::Relevance,
        )
        .expect("search");

    assert!(!hits.is_empty(), "expected hits for 'Tauri ビルド'");
    assert_eq!(
        hits[0].session_id, "00000000-0000-0000-0000-000000000001",
        "top hit should be the Tauri build session",
    );
}

#[test]
fn finds_oauth_session_by_keyword() {
    let (idx, _tmp) = fresh_index();
    let hits = idx
        .search(
            "リフレッシュトークン",
            None,
            10,
            None,
            None,
            SearchSort::Relevance,
        )
        .expect("search");

    assert!(!hits.is_empty(), "expected hits for 'リフレッシュトークン'");
    let top_session = &hits[0].session_id;
    assert_eq!(top_session, "00000000-0000-0000-0000-000000000002");
}

#[test]
fn msg_type_filter_limits_results() {
    let (idx, _tmp) = fresh_index();
    let hits = idx
        .search(
            "min-height",
            None,
            10,
            None,
            Some(&["user".to_string()]),
            SearchSort::Relevance,
        )
        .expect("search");

    assert!(
        hits.iter().all(|h| h.msg_type == "user"),
        "filter should restrict to user messages, got: {:?}",
        hits.iter().map(|h| &h.msg_type).collect::<Vec<_>>()
    );
}
