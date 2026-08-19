# UnitTrack domain glossary

## LogicalTrack

The canonical musical work in a user's library or queue. It has descriptive
metadata and one or more alternative sources; it is not itself a file, URL,
or playback session.

## SourceRef

One candidate way to obtain a `LogicalTrack`, routed to a specific Source
Provider by `pluginId` and described by a provider-owned `SourceToken`.

## SourceToken

A persistent handle minted and interpreted only by its owning Source Provider.
It may be stored locally, but other modules must not parse it or expose its
raw value to users or logs.

## ResolvedSource

A short-lived playable delivery descriptor produced from a `SourceRef`.
It describes the concrete media delivery, not the track's identity.

## QueueItem

A queue-scoped occurrence of a `LogicalTrack`. Its identity is distinct from
the track identity, so the same track may appear in a queue more than once.

## Canonical queue

The ordered set of `QueueItem`s, current selection, and playback modes owned
by `CorePlayer`. Playback engines never mutate or own this queue.

## Playback plan

A revisioned, short-lived lookahead snapshot derived from the canonical queue
and sent by `CorePlayer` to an engine that can pre-buffer upcoming tracks.
It is disposable playback state, not a second queue.

## Playback engine

An adapter that renders a `ResolvedSource` and reports what actually started
or exhausted. It may optimise transitions within a playback plan, but it does
not make queue-policy decisions.

## Source availability

The host-requested assessment of whether a `SourceRef` has a registered
provider and, when applicable, a token that provider has revalidated. It is
not a guarantee that playback will succeed.
