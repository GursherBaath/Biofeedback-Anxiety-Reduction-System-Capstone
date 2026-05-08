# plot_realtime_data_all_ppg.py
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider, Button

FS = 100  # Hz
DATA_PATH = "output_filter_testing/ppg_window_data.txt"
PEAKS_PATH = "output_filter_testing/ppg_peaks_data.txt"

def load_ppg(path):
    with open(path, "r") as f:
        data = [float(line.strip()) for line in f if line.strip()]
    return np.array(data, dtype=float)

def load_peaks(path):
    try:
        with open(path, "r") as f:
            peaks = [int(line.strip()) for line in f if line.strip()]
        return np.array(peaks, dtype=int)
    except FileNotFoundError:
        return np.array([], dtype=int)

def main():
    y = load_ppg(DATA_PATH)
    peaks = load_peaks(PEAKS_PATH)

    n = len(y)
    t = np.arange(n) / FS

    win_sec = 5.0
    win_samples = int(win_sec * FS)

    fig, ax = plt.subplots(figsize=(10, 5))
    plt.subplots_adjust(bottom=0.30)

    start = 0
    end = min(start + win_samples, n)
    line, = ax.plot(t[start:end], y[start:end], lw=1, color="blue")
    peak_scatter, = ax.plot([], [], "ro", markersize=4)

    ax.set_title("PPG Viewer (Window Combined + Peaks)")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("PPG")
    ax.grid(True)

    # Fixed y-limits (no auto adjust by default)
    fixed_ylim = (400, 800)
    ax.set_ylim(*fixed_ylim)
    auto_scale = False

    def autoscale(x, yseg):
        pad = 0.05 * np.ptp(yseg) if np.ptp(yseg) > 0 else 1.0
        ax.set_xlim(x[0], x[-1])
        ax.set_ylim(np.min(yseg) - pad, np.max(yseg) + pad)

    ax_start = plt.axes([0.12, 0.17, 0.78, 0.03])
    ax_win = plt.axes([0.12, 0.12, 0.78, 0.03])

    max_start = max(0, n - 1) / FS
    s_start = Slider(ax_start, "Start (s)", 0.0, max_start, valinit=0.0, valstep=1/FS)
    s_win = Slider(ax_win, "Window (s)", 1.0, max(5.0, n/FS), valinit=win_sec, valstep=0.5)

    ax_btn_reset = plt.axes([0.12, 0.05, 0.15, 0.05])
    btn_reset = Button(ax_btn_reset, "Reset 5s")

    ax_btn_auto = plt.axes([0.30, 0.05, 0.20, 0.05])
    btn_auto = Button(ax_btn_auto, "Auto Scale: OFF")

    def update(_=None):
        start_sec = s_start.val
        win_sec = s_win.val
        start_idx = int(start_sec * FS)
        win_samples = int(win_sec * FS)
        end_idx = min(start_idx + win_samples, n)

        if end_idx - start_idx < 2:
            return

        x = t[start_idx:end_idx]
        yseg = y[start_idx:end_idx]
        line.set_data(x, yseg)
        ax.set_xlim(x[0], x[-1])

        # Peaks in window
        in_window = peaks[(peaks >= start_idx) & (peaks < end_idx)]
        peak_x = in_window / FS
        peak_y = y[in_window] if len(in_window) else np.array([])
        peak_scatter.set_data(peak_x, peak_y)

        if auto_scale:
            autoscale(x, yseg)
        else:
            ax.set_ylim(*fixed_ylim)

        fig.canvas.draw_idle()

    def reset(event):
        s_win.set_val(5.0)

    def toggle_auto(event):
        nonlocal auto_scale
        auto_scale = not auto_scale
        btn_auto.label.set_text("Auto Scale: ON" if auto_scale else "Auto Scale: OFF")
        update()

    s_start.on_changed(update)
    s_win.on_changed(update)
    btn_reset.on_clicked(reset)
    btn_auto.on_clicked(toggle_auto)

    update()
    plt.show()

if __name__ == "__main__":
    main()