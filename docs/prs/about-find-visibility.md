# Visible diagnostic Find results

On macOS, About Find selected the matching text internally but did not paint it while the search input had focus. In the dark theme, the result count also inherited black text against the dark dialog background. Searching for `Version:` reproduced both problems in the production build from `75eba113`.

About and Protocol Log now draw one noninteractive marker over the current match, independent of native textarea selection painting. The marker follows navigation, scrolling, resizing and live log appends, and is clipped to the text viewport. Closing Find, clearing the query, finding no matches or replacing the text hides it. The existing readonly textarea remains responsible for selection and copying. About's Find bar uses the theme text colour so counts and no-match feedback stay readable.

Both native and browser About use the same positioning wrapper. It follows a moved browser dialog without extra position tracking. Border-box sizing keeps About's textarea border and scrollbars inside the wrapper.

## Validation

- Two regressions fail on the unchanged binary: a screenshot comparison detects zero changed pixels over the selected word while Find has focus, and the dark count fails the contrast check. Both pass with this change.
- All four native diagnostic tests pass in the real macOS Tauri webview with Dyalog. They cover visible Find results, both-theme count contrast, match navigation, Copy and Copy All, live-log selection/scroll preservation and native Edit-menu routing.
- All 126 Node tests pass. The zero-footprint build and Chrome smoke pass.
- Supplementary native checks pass for a distant match, horizontal and vertical clipping, scrolling back to the match and closing Find. Screenshots in both themes show the current word highlighted and the count readable.
- A browser About check confirms visible marker geometry, retained query focus, moving the dialog, no-match cleanup and text reset.
- Independent implementation and test review approved the change. JavaScript syntax and diff checks pass. No new diagnostic.js lint findings were introduced; its existing lint findings remain.

The installed production app is unchanged until this PR is merged and rebuilt.
