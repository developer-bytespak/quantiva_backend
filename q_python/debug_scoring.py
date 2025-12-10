"""
Debug why events aren't being scored
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from src.services.engines.event_risk_engine import EventRiskEngine

engine = EventRiskEngine()

# Get events for AAPL
events = engine._get_upcoming_events('AAPL', 'stock', days_ahead=30)
print(f"\nDetected {len(events)} events for AAPL")

if events:
    print("\nFirst 3 events:")
    for i, event in enumerate(events[:3], 1):
        print(f"\n{i}. Type: {event.get('type')}")
        print(f"   Date: {event.get('date')}")
        print(f"   Description: {event.get('description', '')[:60]}")
        
        # Score the event
        score = engine._score_event(event)
        print(f"   Score: {score}")
        print(f"   Impact: {engine.event_impacts.get(event.get('type'), 'NOT FOUND')}")

