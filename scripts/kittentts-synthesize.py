#!/usr/bin/env python3
import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Synthesize stdin text with KittenTTS.")
    parser.add_argument("--model", default="KittenML/kitten-tts-nano-0.8")
    parser.add_argument("--voice", default="Jasper")
    parser.add_argument("--output", required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        raise SystemExit("stdin text is required")

    try:
        from kittentts import KittenTTS
    except Exception as exc:
        raise SystemExit(f"Failed to import kittentts: {exc}") from exc

    model = KittenTTS(args.model)
    model.generate_to_file(
        text,
        voice=args.voice,
        output_path=args.output,
        speed=args.speed,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
