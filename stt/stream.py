#!/usr/bin/env python3
"""Stream the mic to Soniox real-time STT; print one JSON line per 0.15 s with the live
spoken text (Persian, English or mixed), its English version and the mic level:
{"fa": "...", "en": "...", "lvl": 0.0-1.0}.

Stop: create the file $FA_STOP. The mic closes, Soniox finalizes the rest (the English
lags the spoken text), one last line with "done": true is printed, and the process exits.
Key: $SONIOX_API_KEY or ~/.config/soniox/key. Mic: $FA_MIC (avfoundation index or "default").
$FA_CONTEXT: Soniox `context` JSON (project terms). $FA_INPUT: an audio file instead of the mic (tests).
"""
import array, asyncio, json, math, os, sys

import websockets

URL = "wss://stt-rt.soniox.com/transcribe-websocket"
MIC = os.environ.get("FA_MIC", "default")
STOP = os.environ.get("FA_STOP", "/tmp/persian-voice.stop")
RATE, CHUNK = 16000, 3200            # 0.2 s chunks of s16le


def key():
    k = os.environ.get("SONIOX_API_KEY")
    if not k:
        try:
            k = open(os.path.expanduser("~/.config/soniox/key")).read().strip()
        except OSError:
            sys.exit("No key: set SONIOX_API_KEY or write it to ~/.config/soniox/key")
    return k


def level(chunk):
    """0..1 loudness of a s16le chunk, on a log scale (quiet room ~0, speech ~0.5-0.9)."""
    s = array.array("h", chunk[: len(chunk) // 2 * 2])
    rms = math.sqrt(sum(x * x for x in s) / max(len(s), 1))
    return round(min(1.0, max(0.0, (math.log10(rms + 1) - 2.0) / 2.0)), 2)


async def main():
    if os.path.exists(STOP):
        os.remove(STOP)
    src = ["-re", "-i", os.environ["FA_INPUT"]] if os.environ.get("FA_INPUT") else ["-f", "avfoundation", "-i", f":{MIC}"]
    ff = await asyncio.create_subprocess_exec(
        "ffmpeg", "-loglevel", "error", *src, "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-",
        stdout=asyncio.subprocess.PIPE)
    final = {"fa": "", "en": ""}   # confirmed text, never changes
    live = {"fa": "", "en": ""}    # provisional tail, replaced on every message
    lvl = [0.0]
    snap = lambda: {"fa": final["fa"] + live["fa"], "en": final["en"] + live["en"], "lvl": lvl[0]}

    config = {
        "api_key": key(), "model": "stt-rt-v5", "audio_format": "pcm_s16le",
        "sample_rate": RATE, "num_channels": 1, "language_hints": ["fa", "en"],
        "translation": {"type": "one_way", "target_language": "en"}}
    if os.environ.get("FA_CONTEXT"):
        config["context"] = json.loads(os.environ["FA_CONTEXT"])

    async with websockets.connect(URL) as ws:
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
                    sys.exit(f"Soniox error: {msg.get('error_message')}")
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

        async def watch():
            while not os.path.exists(STOP):
                await asyncio.sleep(0.1)
            os.remove(STOP)
            ff.terminate()         # closes the pipe, so send() ends the stream

        async def tick():
            while True:
                print(json.dumps(snap(), ensure_ascii=False), flush=True)
                await asyncio.sleep(0.15)

        ticker = asyncio.create_task(tick())
        watcher = asyncio.create_task(watch())
        await asyncio.gather(send(), recv())
        ticker.cancel()
        watcher.cancel()
        print(json.dumps({**snap(), "done": True}, ensure_ascii=False), flush=True)


try:
    asyncio.run(main())
except KeyboardInterrupt:
    pass
