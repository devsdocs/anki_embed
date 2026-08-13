# Obsidian Anki Embed

An Obsidian plugin that embeds interactive Anki flashcard decks directly into your notes using [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect).

## Features

- **Interactive Flashcard Player**: Review flashcards directly inside your Obsidian notes with flip animations, rating buttons (`Again`, `Hard`, `Good`, `Easy`), and session summary statistics breakdown.
- **Interactive Deck Picker with Live Search**: Choose decks dynamically via an inline picker (`select: true`) or switch decks on the fly using the **📚 Change deck** header action.
- **Ribbon Action**: Click the left sidebar ribbon icon to instantly pick and insert an Anki deck into your active note.
- **Full AnkiConnect API Coverage**: Strongly-typed wrappers for all 40+ AnkiConnect endpoints (Decks, Cards, Notes, Models, Media, GUI, Stats, and Sync).
- **AnkiConnect Integration**: Connects locally to Anki via `http://127.0.0.1:8765`.
- **Card Rating & Sync**: Rate cards and sync review status directly to Anki.
- **Flexible Code Block Syntax**:
  - Embedded specific deck:
    ```anki
    deck: Japanese::Kanji
    limit: 20
    filter: due
    randomize: true
    ```
  - Simple single-line deck embed:
    ```anki-embed
    Medical::Pharmacology
    ```
  - Interactive deck picker:
    ```anki
    select: true
    ```
    or
    ```anki
    deck: ?
    ```
  - Custom search queries:
    ```anki
    query: deck:"Default" is:due tag:vocab
    ```
- **Pasted Anki URI Auto-Conversion**: Pasting `anki://deck/...` or `anki:...` links automatically converts them into an ````anki code block.
- **Command Palette Tools**:
  - `Insert Anki deck embed`: Fuzzy pick an Anki deck and insert code block into active editor.
  - `Insert interactive Anki deck picker`: Inserts `select: true` interactive picker block.
  - `Import Anki notes from CSV/TSV`: Opens a step-by-step modal to paste and map CSV/TSV data directly into an Anki deck.
  - `Sync Anki collection`: Synchronize your Anki collection directly from Obsidian.
  - `Test AnkiConnect connection`: Instant connectivity check with Notice feedback.
- **Keyboard Shortcuts**:
  - `Space` / `Enter`: Reveal card answer.
  - `1`, `2`, `3`, `4`: Rate card (`1: Again`, `2: Hard`, `3: Good`, `4: Easy`).
  - `R`: Refresh deck session.

## Prerequisites

1. Use Obsidian 1.13.0 or newer.
2. Install [Anki](https://apps.ankiweb.net/).
3. Install the **AnkiConnect** add-on in Anki (Add-on code: `2055492159`).
4. Make sure Anki is open while reviewing notes in Obsidian.

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Place them in your vault's `.obsidian/plugins/anki-embed/` folder.
3. Enable **Anki Embed** in Obsidian settings.

## Known Limitations

- **Review Time Statistics**: Due to limitations in the AnkiConnect API, this plugin cannot send the actual time you spent reviewing a card. When you submit an answer from Obsidian, Anki records the time taken as roughly **0 seconds**. Your card scheduling and intervals will still calculate perfectly, but your total "Review Time" statistics in Anki will be artificially low for cards reviewed via the embed.

## License

MIT
