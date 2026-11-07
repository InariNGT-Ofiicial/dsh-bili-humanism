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
    def run_adapter(self, rows, audio_duration=120.6):
        import json
        class Model:
            def __init__(self, *args, **kwargs): pass
            def transcribe(self, *args, **kwargs):
                return iter(SimpleNamespace(start=a, end=b, text=c) for a,b,c in rows), SimpleNamespace(duration=audio_duration)
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "synthetic.m4s"; source.write_bytes(b"synthetic")
            target = Path(folder) / "asr.json"
            args = [str(SCRIPT), "asr", str(source), str(target), "--duration", "120", "--model", folder]
            with patch.object(sys, "argv", args), patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=Model)}): MEDIA.main()
            return json.loads(target.read_text(encoding="utf8"))["segments"]

    def test_valid_accepted_audio_tail_keeps_text_and_order(self):
        rows = self.run_adapter([(119, 120.2, " First "), (120.3, 120.6, " Tail ")])
        self.assertEqual(rows, [{"start":119,"end":120,"text":"First"}, {"start":120,"end":120,"text":"Tail"}])

    def test_implausible_or_reversed_tail_is_not_hidden_by_reconciliation(self):
        for start,end in [(121.2,121.5),(120.4,120.2)]:
            row = self.run_adapter([(start,end,"Synthetic")])[0]
            self.assertGreater(row["start"], row["end"])
        with self.assertRaisesRegex(RuntimeError, "source metadata"):
            self.run_adapter([(120.3,120.6,"Synthetic")], audio_duration=121.1)


if __name__ == "__main__":
    unittest.main()
