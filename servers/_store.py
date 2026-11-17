"""Where bookings are kept: a dict in this process, or Redis.

BOOKINGS_STORE=memory (default): the dict the bookings server passes in.
BOOKINGS_STORE=redis: REDIS_URL, so every replica sees the same bookings.
The redis package is imported only in the redis case; Demo 1 never needs it.
"""

import json
import os
import time


def repeat_key(booking: dict) -> str:
    """Two requests with the same flight, hotel and nights are the same trip."""
    return f"repeat:{booking['flight']}:{booking['hotel_id']}:{booking['nights']}"


class MemoryStore:
    def __init__(self, bookings: dict[str, dict]) -> None:
        self.bookings = bookings

        self.recent: dict[str, tuple[str, float]] = {}  # repeat key -> (id, expires)

    def save(self, booking: dict, repeat_seconds: int = 0) -> dict:
        """Store the booking and return the one that stands: this one, or an
        identical one made less than repeat_seconds ago (0 = never)."""
        if repeat_seconds:
            key = repeat_key(booking)
            earlier_id, expires = self.recent.get(key, ("", 0.0))
            if time.monotonic() < expires and earlier_id in self.bookings:
                return self.bookings[earlier_id]
            self.recent[key] = (booking["booking_id"], time.monotonic() + repeat_seconds)
        self.bookings[booking["booking_id"]] = booking
        return booking

    def pop(self, booking_id: str) -> dict | None:
        booking = self.bookings.pop(booking_id, None)
        if booking is not None:
            # A cancelled trip can be booked again straight away.
            self.recent.pop(repeat_key(booking), None)
        return booking


class RedisStore:
    """One key per booking, `booking:<id>`, holding the booking as JSON."""

    def __init__(self, url: str) -> None:
        import redis  # only installed in the Demo 2 image

        # Short timeouts: a missing Redis must become a tool error the model
        # can read, not a turn that hangs until the host's 60 s limit.
        self.client = redis.Redis.from_url(
            url, decode_responses=True, socket_connect_timeout=2, socket_timeout=2
        )

    def save(self, booking: dict, repeat_seconds: int = 0) -> dict:
        """Store the booking and return the one that stands: this one, or an
        identical one made less than repeat_seconds ago (0 = never)."""
        own_key = f"booking:{booking['booking_id']}"
        self.client.set(own_key, json.dumps(booking))
        if not repeat_seconds:
            return booking
        # SET NX is atomic: when two replicas get the same request at the
        # same moment, exactly one of them claims the repeat key.
        key = repeat_key(booking)
        if self.client.set(key, booking["booking_id"], nx=True, ex=repeat_seconds):
            return booking
        earlier_raw = self.client.get(f"booking:{self.client.get(key)}")
        if earlier_raw:
            self.client.delete(own_key)  # ours was the repeat; drop it
            return json.loads(earlier_raw)
        # The earlier booking is gone (cancelled a moment ago): ours stands.
        self.client.set(key, booking["booking_id"], ex=repeat_seconds)
        return booking

    def pop(self, booking_id: str) -> dict | None:
        # GETDEL is atomic: two replicas cannot both cancel the same booking.
        raw = self.client.getdel(f"booking:{booking_id}")
        if not raw:
            return None
        booking = json.loads(raw)
        # A cancelled trip can be booked again straight away.
        self.client.delete(repeat_key(booking))
        return booking


def make_store(memory: dict[str, dict]) -> MemoryStore | RedisStore:
    kind = os.environ.get("BOOKINGS_STORE", "memory")
    if kind == "memory":
        return MemoryStore(memory)
    if kind == "redis":
        return RedisStore(os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0"))
    raise SystemExit(f"BOOKINGS_STORE must be memory or redis, got {kind!r}")
