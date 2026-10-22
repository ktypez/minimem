# DESIGN.md — minimem

Brand direction for the web UI (`public/index.html`). This file is the *source*
for the visual system: change it here first, then change the CSS to match.
`antislop` is the filter applied on top, not a substitute for this file.

## Identity

minimem is the lab's shared memory store. The interface is the **notebook page**
the memories live on, not a dashboard about memories: ruled graph paper, ink
outlines, one stamped display face, and a chip-shaped character called **Bit**
who keeps things.

- **Product**: minimem, the memory layer for agents that act.
- **Voice**: plain, specific, a little dry. Thai primary, English for anything
  technical (paths, headers, field names). No marketing voice.
  - **The Thai word for the product is คลัง** (a depot, a storehouse), never
    ร้าน (a shop). A memory store is a place you keep things, not a place you
    sell them. The English copy may still say "store" where the API does.
  - **An agent is an agent.** Never คน ("a person") for something that is
    software. "agent ที่ถูกเรียก" beats "คนที่ถูกเรียก". Thai has no neutral
    pronoun for a machine, so name the thing instead of pronouning it.
  - **Counts carry their unit.** "67 คู่", "24 เรื่อง", "42 บทเรียน". A bare
    number next to a label is a number the reader has to guess at.
  - **No em dashes.** Comma, colon, or parentheses.
- **Mascot**: Bit, a memory chip. Square body, pins on the sides, a yellow
  flag on top. He is the only character in the product, and he is drawn, never
  photographed or rendered in 3D.
- **Mark**: the chip glyph, used in the header and the favicon.

## Personality

Printed, technical, unhurried. It should feel like a well-kept lab notebook:
dense, exact, and slightly opinionated. It should never feel like a SaaS
marketing page, and never like a toy.

## Palette

Core colours and one accent. Everything else is a state colour, used only where
the meaning demands it.

| role | value | where |
|---|---|---|
| ink | `#111111` | every outline, every rule, body text |
| paper | `#FFFFFF` | panels, cards, fields |
| cream | `#FFFBEA` | the default plate ground |
| blue | `#1557F5` | the product itself: hero, primary actions, links |
| yellow | `#FFD400` | the one accent: the primary button, one emphasis per screen |
| green | `#64D982` | verified, executed, success |
| pink | `#E94B85` | disputed, escalation, destructive |
| cyan | `#12A9E8` | data, the keyword path, informational |
| lavender | `#B79BE9` | preview, secondary, the slow layer |

**Plate grounds** are surfaces, not accents: cream `#FFFBEA`, pale yellow
`#FFF3A6`, pale blue `#BDE7FA`, lilac `#EACCF5`, pale pink `#F9C8D8`. A plate
ground carries the section's role, never the section's message.

Night is the same print, pressed in reverse: grounds go dark, the accent and
state colours keep their ink, and the paper becomes ink-black.

## Typography

- **Display**: Archivo Black, with Bai Jamjuree for Thai. Reason: a stamped,
  overstruck letterform that reads as ink on paper, and it holds up at 84px in
  the hero. Headlines only.
- **Mono**: JetBrains Mono, with Chakra Petch for Thai. Reason: minimem is a
  machine-facing store, so every label, path, metric and tab is written in the
  voice of the machine that reads it. Never used for prose.
- **Body**: Bai Jamjuree. Reason: one humanist face for Thai and Latin, so the
  page does not read as two languages fighting.

## Motifs

1. **The chip.** Bit and the mark are the same object. The chip appears in the
   header, in the hero, in the conversion block, and in the footer.
2. **The ruled page.** Graph paper under every light plate. Reason: minimem is
   a notebook the agents write in; the grid is the ruling, and it keeps the
   printed objects legible without competing with them.
3. **Hard offset.** A 3 to 6px solid black offset, never a blur. Reason:
   letterpress, not glass.

## Dials

**ENERGY 2 / RHYTHM 3 / MOTION 1**

Energy 2: the hero is loud, the rest of the page is a working tool.
Rhythm 3: sections change composition deliberately (a scale, a window, a
split, a dense grid, a chart). The long-form sections live on the Info page,
so the home page opens short.
Motion 1: the ticker scrolls, cards lift 2px on hover, bars fill once when
they scroll into view. No floating, no bouncing.

**Design Read**: reading this as *a working tool for the people who run the
lab's agents*, in a *printed lab notebook* language, dial **2 / 3 / 1**.

## Why this, and not that

The reasons every technique had to earn its place.

- **Graph paper.** The store is a notebook the agents write in. The ruling
  gives the page a ground the printed objects sit on, and it says "this is a
  working record", not "this is a landing page". It stays under 9% opacity so
  it never competes with text.
- **Hard offset shadows, never blur.** Letterpress, not glass. A blurred
  shadow floats the object off the page; a 4px black offset prints it on.
- **Archivo Black for headlines.** A stamped, overstruck letterform that
  reads as ink on paper and still holds at 84px.
- **JetBrains Mono for everything technical.** minimem is read by machines
  first: paths, field names, metrics, tab labels, log lines. The mono face
  is that voice, so technical text looks like what it is. Never used for
  prose.
- **The chip is the only illustration.** There is no stock art in the
  product. Bit is the store drawn as the object that does the storing, so
  the mascot and the logo are the same drawing and cannot drift apart.
- **Blue is the product, yellow is the accent.** One accent only. Yellow
  marks the single most important thing on a screen: the primary action, the
  middle layer, the claim being measured.
- **Green, pink, cyan and lavender are state colours, not decoration.**
  They appear only where they mean something: verified, disputed, the
  keyword path, the slow path. A colour that means nothing never appears.
- **Cards carry real data.** The memory store, the relay, the endpoint
  surface and the benchmarks are the product. A card that does not carry a
  measurement, a command or a decision does not get a card.
- **Motion is functional.** The ticker marks a section boundary. The bars
  fill when the number scrolls into view. A card lifts 2px so you know what
  you are about to press. Nothing moves on its own.
- **Icons are the product's own objects.** A drawer, a tag, a lease, a
  ledger, a chip. No sparkle, no magic, no robot.

## Rules we hold

- No em dashes in UI copy. Comma, colon, or parentheses.
- Every number on the page is measured or counted, and says where it came
  from. No invented statistics.
- Nothing links to a page that does not exist.
- The header is one row on a phone. The tab bar becomes a drawer.
