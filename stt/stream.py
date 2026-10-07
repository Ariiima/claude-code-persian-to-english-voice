#!/usr/bin/env python3
"""Stream the mic to a real-time STT engine; print one JSON line per 0.15 s with the live
spoken text (Persian, English or mixed), its English version and the mic level:
{"fa": "...", "en": "...", "lvl": 0.0-1.0}.

Engine: $FA_ENGINE = "soniox" (default; speech + translation) or "google" (Gemini 3.5 Transcribe
over the Live API; speech only, "en" stays empty and the plugin has Claude translate it).

Stop: create the file $FA_STOP. The mic closes, the engine finalizes the rest (the English
lags the spoken text), one last line with "done": true is printed, and the process exits.
Or "local": Whisper on this Mac (needs requirements-local.txt; $FA_LOCAL_MODEL, $FA_LOCAL_LANG; no key, no live text).
Soniox key: $SONIOX_API_KEY or ~/.config/soniox/key.
Gemini key: $GEMINI_API_KEY or ~/.config/gemini/key. $FA_GEMINI_MODEL: default gemini-3.5-transcribe-live.
$FA_GEMINI_LANGS: comma list of BCP-47 codes to favour (default "fa-IR"; empty = detect by itself).
Mic: $FA_MIC (avfoundation index or "default").
$FA_CONTEXT: project terms JSON (Soniox `context`; Gemini uses its `terms` as custom vocabulary).
$FA_INPUT: an audio file instead of the mic (tests).
"""
import array, asyncio, atexit, base64, json, math, os, signal, sys

import websockets

ENGINE = os.environ.get("FA_ENGINE", "soniox")
URL = "wss://stt-rt.soniox.com/transcribe-websocket"
MIC = os.environ.get("FA_MIC", "default")
STOP = os.environ.get("FA_STOP", "/tmp/persian-voice.stop")
RATE, CHUNK = 16000, 3200            # 0.2 s chunks of s16le


def secret(env, path, name):
    k = os.environ.get(env)
    if not k:
        try:
            k = open(os.path.expanduser(path)).read().strip()
        except OSError:
            return None
    return k


def key():
    k = secret("SONIOX_API_KEY", "~/.config/soniox/key", "Soniox")
    if not k:
        sys.exit("No key: set SONIOX_API_KEY or write it to ~/.config/soniox/key")
    return k


def level(chunk):
    """0..1 loudness of a s16le chunk, on a log scale (quiet room ~0, speech ~0.5-0.9)."""
    s = array.array("h", chunk[: len(chunk) // 2 * 2])
    rms = math.sqrt(sum(x * x for x in s) / max(len(s), 1))
    return round(min(1.0, max(0.0, (math.log10(rms + 1) - 2.0) / 2.0)), 2)


async def soniox(ff, final, live, lvl):
    config = {
        "api_key": key(), "model": "stt-rt-v5", "audio_format": "pcm_s16le",
        "sample_rate": RATE, "num_channels": 1, "language_hints": ["fa", "en"],
        "translation": {"type": "one_way", "target_language": "en"}}
    if os.environ.get("FA_CONTEXT"):
        config["context"] = json.loads(os.environ["FA_CONTEXT"])

    # proxy=None: websockets 15+ reads the macOS system proxy; a local SOCKS proxy then resets or breaks the stream.
    # ponytail: set FA_PROXY=1 to use the system proxy again
    async with websockets.connect(URL, proxy=True if os.environ.get("FA_PROXY") else None) as ws:
        await ws.send(json.dumps(config))

        async def send():
            while chunk := await ff.stdout.read(CHUNK):
                lvl[0] = level(chunk)
                await ws.send(chunk)
            lvl[0] = 0.0
            await ws.send("")      # end of audio: Soniox finalizes and answers "finished"

        async def recv():
            async for raw in ws:
                msg = json.loads(raw)
                if msg.get("error_code"):
                    sys.exit(f"Soniox error: {msg.get('error_message')} (free option: run /fa engine google)")
                live.update(fa="", en="")
                for t in msg.get("tokens", []):
                    # "original" = spoken, to translate; "translation" = English of it;
                    # "none" = spoken in English already: it belongs to both sides.
                    st = t.get("translation_status")
                    sides = ["en"] if st == "translation" else ["fa", "en"] if st == "none" else ["fa"]
                    for side in sides:
                        (final if t.get("is_final") else live)[side] += t["text"]
                if msg.get("finished"):
                    return

        await asyncio.gather(send(), recv())


GEMINI_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key="
GEMINI_MODEL = os.environ.get("FA_GEMINI_MODEL", "gemini-3.5-transcribe-live")
# After the last audio, this much silence from the server = it has said everything.
# Measured on 6 clips: 1.5 s lost the whole text in 3 of 6; 4 s lost none.
GEMINI_TAIL_S = 4.0


async def google(ff, final, live, lvl):
    """Gemini Live API transcription (speech only: "en" stays empty and the plugin has Claude translate)."""
    k = secret("GEMINI_API_KEY", "~/.config/gemini/key", "Gemini")
    if not k:
        sys.exit("No key: set GEMINI_API_KEY or write it to ~/.config/gemini/key")
    # Measured on Persian with English code words: "fa-IR" keeps `parseOrder` whole and still reads English-only
    # speech; auto-detect ("") wrote "parse order". "fa-IR,en-US" was no better than auto-detect.
    langs = [l.strip() for l in os.environ.get("FA_GEMINI_LANGS", "fa-IR").split(",") if l.strip()]
    transcription = {"languageCodes": langs}
    terms = json.loads(os.environ.get("FA_CONTEXT") or "{}").get("terms", [])[:100]  # "best results up to 100"
    if terms:
        transcription["customVocabulary"] = terms
    setup = {"setup": {"model": f"models/{GEMINI_MODEL}", "generationConfig": {"responseModalities": ["TEXT"]},
                       "inputAudioTranscription": transcription}}
    is_sent = False

    async with websockets.connect(GEMINI_URL + k, proxy=True if os.environ.get("FA_PROXY") else None) as ws:
        await ws.send(json.dumps(setup))

        async def send():
            nonlocal is_sent
            while chunk := await ff.stdout.read(CHUNK):
                lvl[0] = level(chunk)
                await ws.send(json.dumps({"realtimeInput": {"audio": {
                    "data": base64.b64encode(chunk).decode(), "mimeType": f"audio/pcm;rate={RATE}"}}}))
            lvl[0] = 0.0
            await ws.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
            is_sent = True

        async def recv():
            idle = 0.0
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), 0.25)
                except asyncio.TimeoutError:
                    idle += 0.25
                    if is_sent and idle >= GEMINI_TAIL_S:
                        return
                    continue
                except websockets.ConnectionClosed:
                    return
                idle = 0.0
                msg = json.loads(raw)
                if msg.get("error"):
                    sys.exit(f"Gemini error: {msg['error']}")
                sc = msg.get("serverContent") or {}
                if sc.get("interimInputTranscription"):
                    live["fa"] = sc["interimInputTranscription"].get("text", "")
                if sc.get("inputTranscription"):    # a finished turn replaces its interim text
                    text = sc["inputTranscription"].get("text", "").strip()
                    final["fa"] += (" " if final["fa"] else "") + text
                    live["fa"] = ""

        await asyncio.gather(send(), recv())


def local_runner(model, langs, prompt):
    """A function audio -> text. mlx-whisper on Apple Silicon (model in $FA_LOCAL_MODEL, default below), else
    faster-whisper (NVIDIA GPU if CUDA works, else CPU int8; $FA_LOCAL_MODEL default large-v3-turbo)."""
    try:
        import mlx_whisper
    except ImportError:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            sys.exit("Local engine not installed: run .venv/bin/pip install -r requirements-local.txt")
        wm = WhisperModel(model or "large-v3-turbo", device="auto", compute_type="auto")
        return lambda audio: "".join(s.text for s in wm.transcribe(
            audio, language=langs, initial_prompt=prompt, condition_on_previous_text=False)[0]).strip()
    return lambda audio: mlx_whisper.transcribe(
        audio, path_or_hf_repo=model or "mlx-community/whisper-large-v3-turbo", language=langs,
        initial_prompt=prompt, condition_on_previous_text=False)["text"].strip()


async def local(ff, final, live, lvl):
    """Whisper on this computer: free, offline, no key. It does not stream: the text arrives after Stop
    ("en" stays empty and the plugin has Claude translate it). The first run downloads the model (~1.6 GB)."""
    import numpy as np
    terms = json.loads(os.environ.get("FA_CONTEXT") or "{}").get("terms", [])[:100]
    # Auto-detect by default: "fa" forced turned English-only speech into garbage (measured on 4 clips).
    run = local_runner(os.environ.get("FA_LOCAL_MODEL"), os.environ.get("FA_LOCAL_LANG") or None, ", ".join(terms) or None)
    warm = asyncio.create_task(asyncio.to_thread(run, np.zeros(RATE, np.float32)))  # loads the model while you talk
    pcm = bytearray()
    while chunk := await ff.stdout.read(CHUNK):
        lvl[0] = level(chunk)
        pcm += chunk
    lvl[0] = 0.0
    await warm
    if len(pcm) > RATE:  # under 0.5 s of audio: nothing to read
        audio = np.frombuffer(bytes(pcm[: len(pcm) // 2 * 2]), np.int16).astype(np.float32) / 32768
        final["fa"] = await asyncio.to_thread(run, audio)


async def main():
    if os.path.exists(STOP):
        os.remove(STOP)
    src = ["-re", "-i", os.environ["FA_INPUT"]] if os.environ.get("FA_INPUT") else ["-f", "avfoundation", "-i", f":{MIC}"]
    ff = await asyncio.create_subprocess_exec(
        "ffmpeg", "-loglevel", "error", *src, "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-",
        stdout=asyncio.subprocess.PIPE)
    atexit.register(lambda: ff.returncode is None and ff.kill())  # never leave ffmpeg holding the mic
    final = {"fa": "", "en": ""}   # confirmed text, never changes
    live = {"fa": "", "en": ""}    # provisional tail, replaced on every message
    lvl = [0.0]
    snap = lambda: {"fa": final["fa"] + live["fa"], "en": final["en"] + live["en"], "lvl": lvl[0]}

    async def watch():
        while not os.path.exists(STOP):
            await asyncio.sleep(0.1)
        os.remove(STOP)
        ff.terminate()             # closes the pipe, so send() ends the stream

    async def tick():
        while True:
            print(json.dumps(snap(), ensure_ascii=False), flush=True)
            await asyncio.sleep(0.15)

    ticker = asyncio.create_task(tick())
    watcher = asyncio.create_task(watch())
    await {"google": google, "local": local}.get(ENGINE, soniox)(ff, final, live, lvl)
    ticker.cancel()
    watcher.cancel()
    print(json.dumps({**snap(), "done": True}, ensure_ascii=False), flush=True)


signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # the plugin kills us with SIGTERM: still run the cleanup below
try:
    asyncio.run(main())
except KeyboardInterrupt:
    pass
