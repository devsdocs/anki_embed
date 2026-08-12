# Obsidian Anki Embed

An Obsidian plugin that embeds interactive Anki flashcard decks directly into your notes using [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect).

## Features

- **Interactive Flashcard Player**: Review flashcards directly inside your Obsidian notes.
- **Full AnkiConnect API Coverage**: Strongly-typed wrappers for all 40+ AnkiConnect endpoints (Decks, Cards, Notes, Models, Media, GUI, Stats, and Sync).
- **AnkiConnect Integration**: Connects locally to Anki via `http://127.0.0.1:8765`.
- **Card Rating & Sync**: Rate cards (`Again`, `Hard`, `Good`, `Easy`) and sync review status directly to Anki.
- **Flexible Code Block Syntax**:
  - ```anki
    deck: Japanese::Kanji
    limit: 20
    filter: due
    randomize: true
    ```
  - Simple single-line deck embed:
    ```anki-embed
    Medical::Pharmacology
    ```
  - Custom search queries:
    ```anki
    query: deck:"Default" is:due tag:vocab
    ```
- **Pasted Anki URI Auto-Conversion**: Pasting `anki://deck/...` or `anki:...` links automatically converts into an ````anki code block.
- **Command Palette Tools**:
  - `Insert Anki Deck Embed`: Fuzzy pick an Anki deck and insert code block into active editor.
  - `Test AnkiConnect Connection`: Instant connectivity check with Notice feedback.
- **Keyboard Navigation**:
  - `Space` / `Enter`: Reveal card answer.
  - `1`, `2`, `3`, `4`: Rate card (`1: Again`, `2: Hard`, `3: Good`, `4: Easy`).
  - `R`: Refresh deck session.

## Prerequisites

1. Install [Anki](https://apps.ankiweb.net/).
2. Install the **AnkiConnect** add-on in Anki (Add-on code: `2055492159`).
3. Make sure Anki is open while reviewing notes in Obsidian.

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Place them in your vault's `.obsidian/plugins/anki-embed/` folder.
3. Enable **Anki Embed** in Obsidian settings.

## License

MIT
