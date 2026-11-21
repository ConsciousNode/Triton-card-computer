# Tritone, the CNSW (Cassette Native Storage Worker): a ternary cassette drive for Triton (sketch)
**Idea:** Kham. **Sketch:** Kehai Interim, 2026-11-21. A future side project, not scheduled. Nothing here is built or Name: Kham (CNSW is also the studio's initials, ConsciousNode SoftWorks).
tested yet.

Save and load TritOS programs on an ordinary audio cassette, one trit per tone, in the spirit of the 1970s Kansas City
Standard (two tones for bits). Any cassette deck works, and the drive needs no special hardware.

## The signal
- **Three tones, one per trit value:** −1 low, 0 middle, +1 high.
  - Pick them in the deck's clean mid-band (about 1–3 kHz), and so that no tone is a harmonic of another. Tape
    distortion adds harmonics: KCS's 1200/2400 Hz pair is exactly 2×, which is a mistake to avoid with three tones.
  - First guess: about 1300 / 1900 / 2700 Hz, to be chosen by measurement.
- **Symbol rate:** first guess 300 trits/s, which is about 4–9 tone cycles per trit.
  - A C90 side (45 min) holds about 810,000 trits = **90,000 trytes**.
  - TritOS 2.1 (3,057 trytes) loads in about **1 min 32 s** (3,057 × 9 / 300 = 92 s).
- **Framing:**
  - A leader tone, so the receiver can lock on and the deck's speed can be measured.
  - Then blocks: a sync pattern, a block number, the data, and a ternary checksum.
  - A bad block can be re-read on the next pass, or the tape can carry two copies of everything.
- **Tape speed wanders** (wow and flutter, a fraction of a percent) and decks differ. The receiver measures tone
  periods against the leader, not against fixed numbers.

## The hardware (discrete parts, no microcontroller)
- **Send:** a counter divides a crystal or SCLK down to the tone. The trit picks the divide ratio. An RC filter
  softens the square wave before the deck's input.
- **Receive:**
  1. A comparator squares up the audio.
  2. A counter measures the time between zero crossings.
  3. A small lookup table (the house style) maps period → trit, with "not a tone" for anything out of range.
  4. A second counter times the symbols.
- **To the CPU:** one I/O port.
  - OUT: queue a trit or a tryte.
  - IN: read a decoded trit plus a ready/error flag.
  - An interrupt when a tryte is ready.
- **Home:** it could be a small card of its own, or ride the I/O card's spare port numbers. That decision goes in the
  same "own card vs mezzanine" weighing as JPUSB.

## How it would be tested, the house way
- A simulated tape between send and receive, with adjustable speed error, wow and flutter, noise, and dropouts.
- Positive controls that must fail: tones too close together, speed error past the tracking range, a checksum that
  ignores a flipped trit.
- Round trip: TritOS out to the simulated tape and back in, byte-identical.
- Then a real deck and a thrift-store tape.
