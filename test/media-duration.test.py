import importlib.util
import math
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/media.py"
SPEC = importlib.util.spec_from_file_location("synthetic_media", SCRIPT)
MEDIA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEDIA)


class FakeImage:
    def save(self, path, quality):
        Path(path).write_bytes(bytes([255, 216, 255, 217]))


class FakeFrame:
    width, height = 160, 96

    def __init__(self, timestamp):
        self.time = timestamp

    def to_image(self):
        return FakeImage()


class FakeContainer:
    def __init__(self, duration):
        self.streams = SimpleNamespace(video=[SimpleNamespace(
            duration=duration, time_base=1,
            codec_context=SimpleNamespace(width=160, height=96))])
        self.duration = None
        self.frames = [FakeFrame(i * (duration - 1) / 1999) for i in range(2000)]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def decode(self, video):
        return iter(self.frames)


class DurationTests(unittest.TestCase):
    def test_source_precision_and_human_limit_are_independent(self):
        MEDIA.check_duration(927.5, SimpleNamespace(duration=927, max_seconds=None))
        MEDIA.check_duration(927.5, SimpleNamespace(duration=927, max_seconds=1200))
        with self.assertRaisesRegex(RuntimeError, "configured limit"):
            MEDIA.check_duration(927.5, SimpleNamespace(duration=927, max_seconds=927))
        with self.assertRaisesRegex(RuntimeError, "source metadata"):
            MEDIA.check_duration(929, SimpleNamespace(duration=927, max_seconds=1200))
        for value in [math.nan, math.inf, -1]:
            with self.assertRaisesRegex(RuntimeError, "Invalid decoded"):
                MEDIA.check_duration(value, SimpleNamespace(duration=927, max_seconds=None))

    def test_default_python_parser_and_sampling_accept_long_sources(self):
        import json
        for duration in [927, 25000]:
            with self.subTest(duration=duration), tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / "synthetic.mp4"
                source.write_bytes(b"synthetic")
                output = Path(folder) / "frames"
                args = [str(SCRIPT), "frames", str(source), str(output),
                        "--duration", str(duration), "--interval", str(duration / 39),
                        "--strict-duration"]
                av = SimpleNamespace(open=lambda _path: FakeContainer(duration))
                with patch.object(sys, "argv", args), patch.dict(sys.modules, {"av": av}):
                    MEDIA.main()
                manifest = json.loads((output / "manifest.json").read_text(encoding="utf8"))
                self.assertLessEqual(len(manifest["frames"]), 40)
                self.assertGreater(manifest["frames"][-1]["at"], duration * 0.9)

    def test_explicit_cap_and_invalid_numbers_fail_before_optional_dependencies(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "synthetic.mp4"
            source.write_bytes(b"synthetic")
            base = [str(SCRIPT), "frames", str(source), str(Path(folder) / "out")]
            for argv in [
                ["--duration", "927", "--max-seconds", "600"],
                ["--duration", "nan"], ["--duration", "inf"],
                ["--duration", "9007199254740992"],
                ["--duration", "927", "--max-seconds", "nan"],
                ["--duration", "927", "--max-seconds", "inf"],
            ]:
                with self.subTest(argv=argv), patch.object(sys, "argv", base + argv):
                    with self.assertRaises(SystemExit) as caught:
                        MEDIA.main()
                    self.assertEqual(caught.exception.code, 2)


class AsrTailTests(unittest.TestCase):
    def segments(self, duration, audio_duration, rows):
        import json

        class FakeModel:
            def __init__(self, *args, **kwargs):
                pass

            def transcribe(self, path, **kwargs):
                return iter(SimpleNamespace(start=s, end=e, text=t) for s, e, t in rows), SimpleNamespace(duration=audio_duration)

        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "synthetic.m4s"
            source.write_bytes(b"synthetic")
            output = Path(folder) / "out.json"
            args = [str(SCRIPT), "asr", str(source), str(output), "--duration", str(duration), "--model", folder]
            module = SimpleNamespace(WhisperModel=FakeModel)
            with patch.object(sys, "argv", args), patch.dict(sys.modules, {"faster_whisper": module}):
                MEDIA.main()
            return json.loads(output.read_text(encoding="utf8"))["segments"]

    def test_a_tail_segment_past_the_metadata_stays_ordered_and_keeps_its_words(self):
        segments = self.segments(120, 120.6, [(0, 2, " 开头 "), (119, 120.4, " 跨过 "), (120.3, 120.6, " 谢谢 ")])
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in segments],
                         [(0, 2, "开头"), (119, 120, "跨过"), (120, 120, "谢谢")])


if __name__ == "__main__":
    unittest.main()
