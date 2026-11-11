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


class SeekingContainer:
    """Keyframes every five frames, one frame per second; decoding starts where the seek landed.
    Seeks go by decode time; delay shows each frame that much later, as frame reordering does."""

    def __init__(self, seconds, refuse_seek=False, width=160, delay=0):
        self.streams = SimpleNamespace(video=[SimpleNamespace(
            duration=seconds, time_base=1,
            codec_context=SimpleNamespace(width=width, height=96))])
        self.duration = None
        self.frames = [FakeFrame(float(i + delay)) for i in range(seconds)]
        for frame in self.frames:
            frame.width = width
        self.position = 0
        self.seeks = []
        self.refuse_seek = refuse_seek

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def seek(self, offset, stream=None):
        if self.refuse_seek:
            raise OSError("synthetic seek refusal")
        self.seeks.append(offset)
        self.position = min(offset - offset % 5, len(self.frames) - 1)

    def decode(self, video):
        while self.position < len(self.frames):
            frame = self.frames[self.position]
            self.position += 1
            yield frame


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

    def test_optional_python_wall_time_has_no_hidden_default_and_honors_human_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "synthetic.mp4"; source.write_bytes(b"synthetic")
            base = [str(SCRIPT), "frames", str(source), str(Path(folder) / "out"), "--duration", "927"]
            av = SimpleNamespace(open=lambda _path: FakeContainer(927))
            for extra in [[], ["--max-wall-seconds", "90"]]:
                with self.subTest(extra=extra), patch.object(sys, "argv", base + extra), patch.dict(sys.modules, {"av": av}), patch.object(MEDIA.time, "monotonic", side_effect=[0] + [1000] * 3000):
                    if extra:
                        with self.assertRaisesRegex(RuntimeError, "wall budget exceeded"): MEDIA.main()
                    else:
                        MEDIA.main()
                        self.assertTrue((Path(folder) / "out/manifest.json").exists())

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
                ["--duration", "927", "--max-wall-seconds", "nan"],
                ["--duration", "927", "--max-wall-seconds", "inf"],
                ["--duration", "927", "--max-wall-seconds", "-1"],
            ]:
                with self.subTest(argv=argv), patch.object(sys, "argv", base + argv):
                    with self.assertRaises(SystemExit) as caught:
                        MEDIA.main()
                    self.assertEqual(caught.exception.code, 2)


class ChosenFrameTests(unittest.TestCase):
    def run_frames(self, folder, at, container, *extra, duration=60):
        import json
        source = Path(folder) / "synthetic.mp4"
        source.write_bytes(b"synthetic")
        output = Path(folder) / "frames"
        args = [str(SCRIPT), "frames", str(source), str(output),
                "--duration", str(duration), "--at", at, "--strict-duration", *extra]
        av = SimpleNamespace(open=lambda _path: container)
        with patch.object(sys, "argv", args), patch.dict(sys.modules, {"av": av}):
            MEDIA.main()
        return json.loads((output / "manifest.json").read_text(encoding="utf8")), output

    def test_each_time_takes_the_first_frame_at_or_after_it(self):
        with tempfile.TemporaryDirectory() as folder:
            container = SeekingContainer(60)
            manifest, output = self.run_frames(folder, "30.5,12", container)
            self.assertEqual(manifest["sampling"], "chosen")
            self.assertEqual([row["at"] for row in manifest["frames"]], [12.0, 31.0])
            self.assertEqual([row["file"] for row in manifest["frames"]],
                             ["frame-000-12.00.jpg", "frame-001-31.00.jpg"])
            self.assertEqual(manifest["frames"][0]["width"], 160)
            self.assertEqual(container.seeks, [10, 28])
            for row in manifest["frames"]:
                self.assertTrue((output / row["file"]).is_file())

    def test_a_keyframe_shown_after_its_decode_time_skips_no_frame(self):
        with tempfile.TemporaryDirectory() as folder:
            # The frame shown at 11 precedes the keyframe found by decode time 10.5, shown at 12.
            manifest, _ = self.run_frames(folder, "10.5", SeekingContainer(60, delay=2))
            self.assertEqual([row["at"] for row in manifest["frames"]], [11.0])

    def test_times_on_one_frame_write_it_once(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest, _ = self.run_frames(folder, "12,12,12.5,13", SeekingContainer(60))
            self.assertEqual([row["at"] for row in manifest["frames"]], [12.0, 13.0])

    def test_a_time_past_the_last_frame_takes_the_last_frame(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest, _ = self.run_frames(folder, "10,60", SeekingContainer(50), duration=60)
            self.assertEqual([row["at"] for row in manifest["frames"]], [10.0, 49.0])

    def test_a_frame_past_the_duration_is_never_returned(self):
        # Decoded time within the one-second tolerance, but beyond what the image layer accepts.
        with tempfile.TemporaryDirectory() as folder:
            container = SeekingContainer(61)
            container.streams.video[0].duration = 60
            manifest, _ = self.run_frames(folder, "59.2", container, duration=59.5)
            self.assertEqual([row["at"] for row in manifest["frames"]], [59.0])

    def test_a_container_refusing_to_seek_decodes_forward(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest, _ = self.run_frames(folder, "3,7", SeekingContainer(60, refuse_seek=True))
            self.assertEqual([row["at"] for row in manifest["frames"]], [3.0, 7.0])

    def test_same_dimension_and_duration_checks_apply(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, "short side"):
                self.run_frames(folder, "1", SeekingContainer(60, width=1000), "--max-short-side", "90")
            with self.assertRaisesRegex(RuntimeError, "source metadata"):
                self.run_frames(folder, "1", SeekingContainer(100))

    def test_invalid_times_fail_before_optional_dependencies(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "synthetic.mp4"
            source.write_bytes(b"synthetic")
            for at in ["", "x", "1,", "nan", "inf", "61", "1,2,3,4,5"]:
                args = [str(SCRIPT), "frames", str(source), str(Path(folder) / "out"),
                        "--duration", "60", f"--at={at}"]
                with self.subTest(at=at), patch.object(sys, "argv", args):
                    with self.assertRaises(SystemExit) as caught:
                        MEDIA.main()
                    self.assertEqual(caught.exception.code, 2)
            args = [str(SCRIPT), "asr", str(source), str(Path(folder) / "out.json"),
                    "--duration", "60", "--at", "1"]
            with patch.object(sys, "argv", args), self.assertRaises(SystemExit) as caught:
                MEDIA.main()
            self.assertEqual(caught.exception.code, 2)


class AsrHintTests(unittest.TestCase):
    def transcribe(self, *flags):
        import json
        seen = {}

        class FakeModel:
            def __init__(self, *args, **kwargs):
                pass

            def transcribe(self, path, **kwargs):
                seen.update(kwargs)
                return iter([SimpleNamespace(start=0, end=1, text=" synthetic ")]), SimpleNamespace(duration=60)

        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "synthetic.m4s"
            source.write_bytes(b"synthetic")
            output = Path(folder) / "out.json"
            args = [str(SCRIPT), "asr", str(source), str(output), "--duration", "60",
                    "--model", folder, *flags]
            module = SimpleNamespace(WhisperModel=FakeModel)
            with patch.object(sys, "argv", args), patch.dict(sys.modules, {"faster_whisper": module}):
                MEDIA.main()
            self.assertEqual(json.loads(output.read_text(encoding="utf8"))["segments"][0]["text"], "synthetic")
        return seen

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

    def test_without_flags_the_call_is_unchanged(self):
        self.assertEqual(self.transcribe(), {
            "beam_size": 1, "vad_filter": False, "condition_on_previous_text": False,
        })

    def test_flags_reach_the_model(self):
        seen = self.transcribe("--initial-prompt", "以下是《标题》", "--hotwords", "标题", "--vad")
        self.assertEqual(seen["initial_prompt"], "以下是《标题》")
        self.assertEqual(seen["hotwords"], "标题")
        self.assertIs(seen["vad_filter"], True)

    def test_a_title_like_an_option_stays_a_value(self):
        for title in ["--model=/elsewhere", "--vad", "-x", "--duration 1", "a=b"]:
            with self.subTest(title=title):
                seen = self.transcribe("--hotwords", title, "--initial-prompt", title)
                self.assertEqual(seen["hotwords"], title)
                self.assertEqual(seen["initial_prompt"], title)
                self.assertIs(seen["vad_filter"], False)


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
