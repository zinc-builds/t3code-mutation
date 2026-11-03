/**
 * Inline because the bundled server cannot read a sibling .py at runtime. One JSON object per
 * line: `ready` once loaded, a `result` or `error` per `{"id","path","ffmpeg","hotwords"}`
 * request, and `fatal` on a startup failure, then exit. It exits when stdin closes. Library
 * output goes to stderr because stdout carries only the protocol.
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
