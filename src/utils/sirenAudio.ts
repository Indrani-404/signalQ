// Web Audio API dual-tone emergency siren generator for Kolkata Green Corridor
class SirenSynthesizer {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private isPlaying = false;
  private timer: number | null = null;
  private highTone = false;

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public start() {
    if (this.isPlaying) return;
    try {
      this.initContext();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(650, this.ctx.currentTime);

      gain.gain.setValueAtTime(0.04, this.ctx.currentTime); // gentle low volume

      // Soft filter to make sound smooth rather than harsh
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1400, this.ctx.currentTime);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start();
      this.osc = osc;
      this.gain = gain;
      this.isPlaying = true;

      // Alternate between 650 Hz and 920 Hz every 450ms (Indian 108 Emergency Siren pattern)
      this.timer = window.setInterval(() => {
        if (!this.osc || !this.ctx) return;
        this.highTone = !this.highTone;
        const targetFreq = this.highTone ? 920 : 650;
        this.osc.frequency.exponentialRampToValueAtTime(targetFreq, this.ctx.currentTime + 0.15);
      }, 450);
    } catch {
      // Audio autoplay policy catch
    }
  }

  public stop() {
    if (!this.isPlaying) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      if (this.gain && this.ctx) {
        this.gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.1);
      }
      setTimeout(() => {
        if (this.osc) {
          this.osc.stop();
          this.osc.disconnect();
          this.osc = null;
        }
      }, 120);
    } catch {
      // Clean exit
    }
    this.isPlaying = false;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }
}

export const sirenPlayer = new SirenSynthesizer();
