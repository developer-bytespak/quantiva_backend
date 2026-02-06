#!/usr/bin/env python3
"""
Diagnose LunarCrush API connection and authentication
"""

import requests
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.config import LUNARCRUSH_API_KEY

print("=" * 80)
print("🔍 LUNARCRUSH API AUTHENTICATION DIAGNOSTIC")
print("=" * 80)

if not LUNARCRUSH_API_KEY:
    print("❌ ERROR: LUNARCRUSH_API_KEY not set in environment!")
    os.sys.exit(1)

print(f"\n✅ API Key found: {LUNARCRUSH_API_KEY[:10]}...{LUNARCRUSH_API_KEY[-10:]}")

# Test 1: Bearer token authentication (current method)
print("\n" + "="*60)
print("TEST 1: Bearer Token Authentication")
print("="*60)

url = "https://lunarcrush.com/api4/public/topic/BTC/news/v1"
headers_bearer = {
    'Authorization': f'Bearer {LUNARCRUSH_API_KEY}',
    'Content-Type': 'application/json'
}

print(f"URL: {url}")
print(f"Headers: {{'Authorization': 'Bearer {LUNARCRUSH_API_KEY[:20]}...'}}")

try:
    response = requests.get(url, headers=headers_bearer, timeout=10)
    print(f"\n✅ Status Code: {response.status_code}")
    print(f"Response Headers:\n  {json.dumps(dict(response.headers), indent=2)}")
    
    if response.status_code == 429:
        print("\n⚠️  Rate limit exceeded - check your account tier or daily limit")
        print(f"   Rate limit info: {response.headers.get('X-RateLimit-Remaining', 'N/A')}")
    elif response.status_code == 401:
        print("\n❌ Authentication failed - API key might be invalid")
    elif response.status_code == 200:
        data = response.json()
        print(f"\n✅ Authentication successful!")
        print(f"   Response type: {type(data)}")
        print(f"   Response keys: {list(data.keys()) if isinstance(data, dict) else 'List'}")
        if isinstance(data, dict) and 'data' in data:
            print(f"   Number of articles: {len(data['data'])}")
    else:
        print(f"\n⚠️  Unexpected status: {response.status_code}")
        print(f"   Response: {response.text[:200]}")
        
except Exception as e:
    print(f"❌ Request failed: {str(e)}")

# Test 2: Query parameter authentication
print("\n\n" + "="*60)
print("TEST 2: Query Parameter Authentication")
print("="*60)

params = {'key': LUNARCRUSH_API_KEY}
url_with_params = f"https://lunarcrush.com/api4/public/topic/BTC/news/v1"

print(f"URL: {url_with_params}?key={LUNARCRUSH_API_KEY[:20]}...")

try:
    response = requests.get(url_with_params, params=params, timeout=10)
    print(f"\n✅ Status Code: {response.status_code}")
    
    if response.status_code == 429:
        print("⚠️  Rate limit exceeded")
    elif response.status_code == 401:
        print("❌ Authentication failed")
    elif response.status_code == 200:
        data = response.json()
        print(f"✅ Authentication successful with query params!")
        print(f"   Response type: {type(data)}")
        if isinstance(data, dict) and 'data' in data:
            print(f"   Number of articles: {len(data['data'])}")
    else:
        print(f"⚠️  Status: {response.status_code}")

except Exception as e:
    print(f"❌ Request failed: {str(e)}")

# Test 3: Account info endpoint (if available)
print("\n\n" + "="*60)
print("TEST 3: Account/Limits Info")
print("="*60)

info_endpoints = [
    "https://lunarcrush.com/api4/account/info",
    "https://lunarcrush.com/api4/me",
    "https://lunarcrush.com/api/v4/account",
]

for info_url in info_endpoints:
    try:
        response = requests.get(
            info_url,
            headers=headers_bearer,
            timeout=5
        )
        if response.status_code in [200, 401, 403]:
            print(f"\n{info_url}: {response.status_code}")
            if response.status_code == 200:
                print(f"Response: {response.json()}")
            break
    except:
        pass

print("\n" + "="*80)
print("✅ Diagnostic complete. Check results above.")
print("="*80)
