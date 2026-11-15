# H3 Editor in CreativeField

The Film Studio embeds [H3 Editor](https://github.com/igorls/comfyui-h3-editor) by Igor LS,
pinned at commit `60c1784` (release 0.9.1). H3 Editor is licensed under **GPL-3.0**; its `LICENSE`
and `NOTICE` are copied with the installed pack, and CreativeField itself is GPL-3.0-only.

## Install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-h3-editor.ps1 -WorkerRoot <worker ComfyUI folder> -PythonExe <worker venv python.exe>
```

Instead of the two arguments you can set `CREATIVEFIELD_H3_WORKER` and `CREATIVEFIELD_H3_PYTHON` once.

The script clones the pinned release into the HyperFlow worker's `custom_nodes/comfyui-h3-editor`,
copies it without `.git`/tests, applies the two CreativeField adaptations, and checks the worker
venv dependencies (`imageio-ffmpeg`, `gguf`). It does not edit any ComfyUI workflow graph.

Restart the HyperFlow worker afterwards and verify `http://127.0.0.1:8309/h3take/editor`.

## CreativeField adaptations

- **Project mapping:** the editor's `start()` reads `?project=cf-<projectId>` and creates that
  project once, then reopens it on every load. `H3FilmStudio` passes the CreativeField project id.
- **Same-origin hosting:** the page is embedded at
  `/h3-editor/<workspaceId>/h3take/editor`; its assets, `/view` media and `/ws` socket are proxied
  by `server/h3-proxy.ts` with workspace membership on every request. No direct worker iframe URL
  is exposed to the browser.
- **Theme:** `scripts/h3-editor-theme.css` maps the editor's variables to the `#ds` tokens
  (`#2fa8ff` accent, `#0f1113`/`#131517` surfaces, Inter, 14 px radius) and the installer also maps
  the canvas waveform, note ink and room fill to the same tokens.
- The Python renderer and upstream ComfyUI nodes are **not** modified. No workflow graphs are authored
  by CreativeField; the editor builds and submits its own upstream graphs.

## Analysis bridge

`server/h3-editor.ts` exposes authenticated workspace routes for project read, clip bytes and note
writes through the local H3 worker. `H3FilmStudio` uses them for the analysis dialog (shot brief,
blocking, measurements) and writes the brief back as an H3 note.
