import requests

SAMPLE_RATE_HZ = 100
SECONDS = 30
SAMPLES = SAMPLE_RATE_HZ * SECONDS

# Load first 30 seconds of PPG data from file
with open("ppg_data.txt", "r", encoding="ascii") as f:
    ppg_data = [int(line.strip()) for line in f if line.strip()]

ppg_data = ppg_data[:SAMPLES]

# Test the API
response = requests.post(
    "http://localhost:8000/analyze",
    json={
        "ppg_data": ppg_data,
        "sampling_rate": SAMPLE_RATE_HZ,
        "max_bad_segments": 0
    }
)

print(response.status_code)
print(response.json())