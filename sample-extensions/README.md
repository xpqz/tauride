# Vim sample for Monaco 0.57

This optional extension bundles `monaco-vim` against Ride's Monaco 0.57 build.
Install it into Ride's user-data directory (for example,
`~/Library/Application Support/Ride-4.8` on macOS), then build the extension:

```sh
npm install --prefix "<user-data-directory>" monaco-vim@0.4.1
node sample-extensions/build-vim.js "<user-data-directory>"
export RIDE_JS="<user-data-directory>/vim.bundle.js"
```

Start Ride with `RIDE_JS` set. The generated bundle uses Ride's existing Monaco
instance and includes the private `ShiftCommand` dependency required by
`monaco-vim`. Rebuild it when changing Monaco versions. This sample is for
Electron and Tauri's `RIDE_JS` loading path; the standalone browser build does
not read local `RIDE_JS` files.
