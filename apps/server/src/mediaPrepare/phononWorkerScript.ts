/**
 * The Python worker T3 runs in its Phonon venv. The server is bundled and
 * cannot read a sibling .py at runtime, so the source lives here and
 * PhononRuntime writes it beside the venv before each start.
 *
 * Protocol, one JSON object per line. The worker loads the model once and
 * writes `{"type":"ready"}`. Each request `{"id","path","ffmpeg","hotwords"}`
 * gets `{"type":"result","id","transcript"}` or `{"type":"error","id",
 * "message"}`. A startup failure writes `{"type":"fatal","message"}` and
 * exits. The worker decodes each source's first audio track with ffmpeg
 * straight into memory (16 kHz mono float32), so it never writes audio to
 * disk. It exits when stdin closes. Library output goes to stderr, which T3
 * logs; stdout carries only the protocol.
 */
export const PHONON_WORKER_SCRIPT = String.raw`import json
import os
import subprocess
import sys
import time

protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(message):
    protocol.write(json.dumps(message) + "\n")
    protocol.flush()


def tail(data, limit=600):
    text = data.decode("utf-8", "replace").strip()
    return text[-limit:]


def timed(entries):
    return [
        {"start": float(entry["start"]), "end": float(entry["end"]), "text": str(entry["text"])}
        for entry in entries
    ]


def decode_audio(ffmpeg, path):
    import numpy

    result = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn",
         "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError("ffmpeg could not decode the audio: " + tail(result.stderr))
    audio = numpy.frombuffer(result.stdout, dtype=numpy.float32)
    if audio.size == 0:
        raise RuntimeError("ffmpeg decoded no audio samples.")
    return audio


def main():
    try:
        import fermion

        started = time.monotonic()
        speech = fermion.load_speech(sys.argv[1], quiet=False)
    except Exception as error:
        send({"type": "fatal", "message": type(error).__name__ + ": " + str(error)[:2000]})
        sys.exit(1)
    send({"type": "ready", "fermion": fermion.VERSION, "loadSeconds": time.monotonic() - started})
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            audio = decode_audio(request["ffmpeg"], request["path"])
            transcript = speech.transcribe_array_detailed(audio, hotwords=request["hotwords"])
            send({
                "type": "result",
                "id": request["id"],
                "transcript": {
                    "text": transcript.text,
                    "segments": timed(transcript.segments),
                    "words": timed(transcript.words),
                    "audioSeconds": float(transcript.audio_seconds),
                    "decodeSeconds": float(transcript.decode_seconds),
                    "truncated": bool(transcript.truncated),
                },
            })
        except Exception as error:
            send({"type": "error", "id": request["id"],
                  "message": type(error).__name__ + ": " + str(error)[:2000]})


main()
`;
