use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera::token::Token;

fn tokenize(segmenter: &Segmenter, text: &str) -> Vec<String> {
    let mut tokens: Vec<Token> = segmenter.segment(text.into()).unwrap_or_default();
    tokens.iter_mut().filter_map(|t| {
        let s = t.surface.to_string();
        if s.trim().is_empty() { None } else { Some(s) }
    }).collect()
}

fn main() {
    let dictionary = load_dictionary("embedded://ipadic").expect("load dict");
    let segmenter = Segmenter::new(Mode::Normal, dictionary, None);

    let tests = vec![
        "そういえば",
        "昨日の天気",
        "Claude Code",
        "エラーが出た",
        "git push",
        "検索クエリの処理",
        "そういえばあの件",
    ];

    for text in tests {
        let tokens = tokenize(&segmenter, text);
        println!("{:20} => {:?}", text, tokens);
    }
}
