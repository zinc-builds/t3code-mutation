/**
 * Pinned so every host resolves the same `fermion-research` (Apache-2.0) and Phonon-2 model
 * (CC-BY-4.0). To bump, check `fermion.load_speech("phonon-2").transcribe_array_detailed(...)`
 * still returns words and segments in a scratch macOS arm64 venv, replace APPLE_SILICON_LOCK with
 * its `pip freeze`, and update the direct pins. Hosts install the new runtime beside the old one.
 */

export const FERMION_VERSION = "0.2.11";
export const PHONON_MODEL = "phonon-2";
/** What a transcript file names as its model. */
export const PHONON_MODEL_ID = "FermionResearch/Phonon-2";

/**
 * numpy 2.5, scipy 1.18 and networkx 3.7 in the lock need Python 3.12, so the
 * runtime does too, although fermion itself accepts 3.10.
 */
export const MIN_PYTHON = { major: 3, minor: 12 } as const;

// `pip freeze` of a venv verified to transcribe with Phonon-2 on macOS arm64
// (Python 3.12), so Apple Silicon hosts install exactly these.
const APPLE_SILICON_LOCK = [
  "annotated-doc==0.0.5",
  "anyio==4.15.1",
  "cffi==2.1.1",
  "click==8.5.0",
  `fermion-research==${FERMION_VERSION}`,
  "filelock==4.1.1",
  "fsspec==2026.9.0",
  "h11==0.16.0",
  "hf-xet==1.7.0",
  "httpcore2==2.13.1",
  "httpx2==2.13.1",
  "huggingface_hub==2.2.0",
  "idna==3.20",
  "Jinja2==3.1.6",
  "markdown-it-py==4.2.0",
  "MarkupSafe==3.0.4",
  "mdurl==0.1.2",
  "miniaudio==1.71",
  "mlx==0.32.3",
  "mlx-audio==0.5.8",
  "mlx-lm==0.32.0",
  "mlx-metal==0.32.3",
  "mpmath==1.3.0",
  "networkx==3.7",
  "numpy==2.5.4",
  "packaging==26.3",
  "protobuf==7.36.2",
  "pycparser==3.11",
  "Pygments==2.21.0",
  "PyYAML==6.0.3",
  "regex==2026.9.29",
  "rich==15.0.0",
  "safetensors==0.8.0",
  "scipy==1.18.1",
  "sentencepiece==0.2.2",
  "setuptools==84.0.0",
  "shellingham==1.5.4",
  "sounddevice==0.5.6",
  "soundfile==0.14.0",
  "sympy==1.14.0",
  "tokenizers==0.23.3",
  "torch==2.14.1",
  "tqdm==4.70.1",
  "transformers==5.19.0",
  "truststore==0.10.4",
  "typer==0.27.3",
  "typing_extensions==4.16.0",
  "zstandard==0.25.0",
];

// Fermion's CPU engine on Linux and Windows, per its install docs.
// Only the direct requirements are pinned here: no host of these kinds has
// verified a full lock yet.
const CPU_REQUIREMENTS = [
  `fermion-research==${FERMION_VERSION}`,
  "torch==2.14.1",
  "safetensors==0.8.0",
  "soundfile==0.14.0",
  "scipy==1.18.1",
  "zstandard==0.25.0",
];

export interface PhononRelease {
  /** Names the install directory; a new pin installs beside the old one. */
  readonly id: string;
  readonly requirements: ReadonlyArray<string>;
}

// fermion-research itself requires torch<2.3 and numpy<2 on Intel macOS, which
// the pins above contradict, so there it chooses its own dependencies.
const INTEL_MAC_REQUIREMENTS = [
  `fermion-research==${FERMION_VERSION}`,
  "soundfile==0.14.0",
  "zstandard==0.25.0",
];

export const phononRelease = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): PhononRelease => {
  if (platform === "darwin" && arch === "arm64") {
    return { id: `fermion-${FERMION_VERSION}-mlx`, requirements: APPLE_SILICON_LOCK };
  }
  if (platform === "darwin") {
    return { id: `fermion-${FERMION_VERSION}-cpu-intel-mac`, requirements: INTEL_MAC_REQUIREMENTS };
  }
  return { id: `fermion-${FERMION_VERSION}-cpu`, requirements: CPU_REQUIREMENTS };
};
