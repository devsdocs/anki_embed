# Obsidian Anki Embed

An Obsidian plugin that embeds interactive Anki flashcard decks directly into your notes using [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect).

## Features

- **Full Editor View & Note Embeds**: Review flashcard decks directly in full workspace editor tabs (`ItemView`) or embedded inside notes. Seamlessly switch from in-note embeds to full view with the **Full view** header action.
- **Interactive Flashcard Player**: Review flashcards with flip animations, rating buttons (`Again`, `Hard`, `Good`, `Easy`), and session summary statistics breakdown.
- **Interactive Deck Picker with Live Search**: Choose decks dynamically via an inline picker (`select: true`) or switch decks on the fly using the **📚 Change deck** header action.
- **Ribbon Action**: Click the left sidebar ribbon icon to open Anki review in a full editor view or insert a deck into your active note.
- **Full AnkiConnect API Coverage**: Strongly-typed wrappers for all 40+ AnkiConnect endpoints (Decks, Cards, Notes, Models, Media, GUI, Stats, and Sync).
- **AnkiConnect Integration**: Connects locally to Anki via `http://127.0.0.1:8765`.
- **Card Rating & Sync**: Rate cards and sync review status directly to Anki.
- **Learn & Browse Modes**: **🎯 Learn** mode orders cards like Anki (learning steps, due reviews, then new cards) and records every rating in Anki's scheduler. **📋 Browse** mode is a linear preview that never changes your schedule. Toggle between them from the header pill.
- **Live Sync with Anki Desktop**: Mirror and control the Anki desktop reviewer in real time (`live: true`). Ratings, undo, suspend, and bury in Obsidian happen in Anki, and cards you answer in Anki show up in Obsidian.
- **Deck Conflict Detection**: If the Anki app has a different deck open than the one you picked, you choose how to continue: **Live** with Anki's deck, **Live** with your deck (switching the Anki app to it), **Offline** with your deck, or **Cancel**. Subdecks of your deck count as the same deck.
- **Safe Answer Recording**: In learn mode, an answer is saved to Anki before the next card appears. If Anki can't be reached, the card stays on screen and you're told it wasn't graded.
- **Note Linking**: Link cards to notes through properties (`linked-cards`), backlinks (`obsidian://anki-card?cardId=...`), or Anki tags (`anki-tags`). The **🔗** button on each card lists every linked, tagged, and backlinked note, and opens any of them side by side with your review.
- **Tag-Based Linking**: Linking a note to a tag also links it to every subtag under it, so a note tagged `AK_Step1_v12::Pathoma::01_Growth_Adaptations` shows up on cards tagged `...::03_Cell_Death`. Real tags are read from Anki, and the list refreshes as soon as you edit a note's properties.
- **Export Cards to Notes**: Create a new note from a card (`C`) or append it to your daily note or a custom note (`A`), with optional automatic linking.
- **Anki Fullscreen Mode**: Distraction-free fullscreen review (`F11` to toggle, `Esc` to exit) with linked notes in a side panel.
- **Card Counts & Review Heatmap**: Live New / Learn / Review counts in the header and a review history heatmap in the deck picker.
- **Card Timer**: Optional per-card timer with warning and limit thresholds, plus a streak for cards answered in time.
- **Flags, Suspend & Bury**: Set Anki flags, suspend, or bury the current card without leaving Obsidian.
- **Anki Remote & Controller Support**: Review with a gamepad or Anki Remote, with fully customizable button mappings.
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
  - Live sync with the Anki desktop reviewer:
    ```anki
    deck: Medical::Pharmacology
    live: true
    ```
  - Learning mode with a card timer:
    ```anki
    deck: Japanese::Kanji
    learning: true
    timer: true
    timer_limit: 10
    ```
  - Single card embed:
    ```anki
    card: 1721832603417
    ```
- **Pasted Anki URI Auto-Conversion**: Pasting `anki://deck/...` or `anki:...` links automatically converts them into an ````anki code block.
- **Command Palette Tools**:
  - `Open Anki review in full view`: Opens interactive Anki review directly in a full workspace tab.
  - `Open Anki deck in full view`: Fuzzy search and open any Anki deck in a full workspace tab.
  - `Insert Anki deck embed`: Fuzzy pick an Anki deck and insert code block into active editor.
  - `Insert interactive Anki deck picker`: Inserts `select: true` interactive picker block.
  - `Import Anki notes from CSV/TSV`: Opens a step-by-step modal to paste and map CSV/TSV data directly into an Anki deck.
  - `Sync Anki collection`: Synchronize your Anki collection directly from Obsidian.
  - `Test AnkiConnect connection`: Instant connectivity check with Notice feedback.
  - `Toggle Anki fullscreen review mode`: Enter or exit distraction-free fullscreen review.
  - `Reset Anki view to deck selection`: Return any open Anki view to the deck picker.
  - `Link Anki tag to current note`: Fuzzy pick an Anki tag and link it to the active note.
  - `Insert Anki tag into editor`: Fuzzy pick an Anki tag and insert it at the cursor.
  - `Search and copy Anki tag`: Fuzzy search Anki tags and copy one to the clipboard.
  - `Manage linked Anki cards for active note`: View and open every card linked to the active note.
  - `Unlink Anki cards from active note`: Remove card links from the active note.
  - `Customize Anki remote and controller buttons`: Remap and test gamepad and remote buttons.
- **Keyboard Shortcuts** (all remappable in settings):
  - `Space` / `Enter`: Reveal card answer, or rate `Good` once revealed.
  - `1`, `2`, `3`, `4`: Rate card (`1: Again`, `2: Hard`, `3: Good`, `4: Easy`).
  - `J`, `K`, `L`, `;`: Reveal, then rate `Again`, `Hard`, `Good`, or `Easy`.
  - `Z` / `U`: Undo last rating.
  - `S`: Suspend card.
  - `B`: Bury card.
  - `F`: Flag card.
  - `C` / `A`: Create a note from the card, or append it to a note.
  - `F11` / `Esc`: Toggle / exit Anki fullscreen mode.
  - `R`: Refresh deck session.

## Prerequisites

1. Use Obsidian 1.13.0 or newer.
2. Install [Anki](https://apps.ankiweb.net/).
3. Install the **AnkiConnect** add-on in Anki (Add-on code: `2055492159`).
4. Make sure Anki is open while reviewing notes in Obsidian.

> [!TIP]
> **Want to use this plugin on Obsidian Mobile or without ever keeping Anki open on your computer?**
> You can host [anki-docker-server](https://github.com/devsdocs/anki-docker-server) on a remote VPS. Just point this plugin's AnkiConnect URL setting to your server's IP to unlock full headless and mobile capabilities!

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Place them in your vault's `.obsidian/plugins/anki-embed/` folder.
3. Enable **Anki Embed** in Obsidian settings.

## Known Limitations & Custom Fork Solution

- **Review Time Statistics**: Due to limitations in the official AnkiConnect API, it cannot record the actual time you spent reviewing a card (it logs as 0 seconds). 
  - **The Solution:** We provide a heavily modified **[Custom AnkiConnect Fork](https://github.com/devsdocs/anki-connect/releases)** that adds time-tracking capabilities. If you install this custom `.ankiaddon` package instead of the official one, simply enable **"Use custom AnkiConnect"** in your Obsidian settings to unlock perfectly accurate review time statistics!

## License

MIT
