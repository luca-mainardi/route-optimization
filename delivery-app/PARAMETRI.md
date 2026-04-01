# Parametri configurabili — effetti sull'algoritmo

---

## Fattorini (`numRiders`)
Numero di rider disponibili. Più rider = più giri paralleli possibili. Influisce anche sul vincolo di disponibilità: se un rider è occupato su uno slot, gli altri devono poter coprire le richieste rimanenti.

---

## Capacità pizze (`pizzeCapacity`)
Massimo numero di pizze che un rider può portare in un singolo giro. Un giro viene scartato in `isTripValid` se `totalPizzas > pizzeCapacity`. Limita quante consegne (ad alta quantità) possono stare nello stesso giro.

---

## T max (min) (`tMaxMin`)
Ritardo massimo assoluto tollerabile per qualsiasi consegna, indipendentemente dalla distanza. Funge da cap sulla `lateToleranceForDelivery`: anche se la tolleranza calcolata con la distanza supererebbe questo valore, non viene mai superato.

---

## Min partenza pre-slot (min) (`earlyToleranceMin`)
Quanti minuti prima dello slot il rider può partire (le pizze non sono pronte prima). Ha due ruoli:

1. **Orario di partenza**: `departureTime ≥ slot - earlyToleranceMin`. Se l'algoritmo vorrebbe partire prima, viene posticipato.
2. **Vincolo disponibilità**: un rider è considerato "occupato" per uno slot se ha già un giro su quello slot in cui `maxTravelTime > earlyToleranceMin`. Se è occupato, lo slot è a rischio scoperto.

---

## Ritardo max (min) (`lateToleranceMin`)
Ritardo base tollerato rispetto all'orario di slot. Viene aumentato in proporzione alla distanza dalla pizzeria tramite `distToleranceFactor`. In `isTripValid`, una consegna viene rifiutata se l'orario di arrivo supera `slot + lateToleranceForDelivery(d)`.

---

## Detour factor (`detourFactor`)
Moltiplicatore sulla distanza in linea d'aria per stimare la distanza reale percorsa (strade, curve, ecc.). Usato in `travelMin`:

```
travelMin = (haversineKm × detourFactor / avgSpeedKmh) × 60
```

Un valore di 1.3 significa che la strada è il 30% più lunga della linea d'aria.

---

## Velocità (km/h) (`avgSpeedKmh`)
Velocità media del rider. Usato insieme a `detourFactor` per stimare tutti i tempi di viaggio.

---

## Sosta (min) (`stopTimeMin`)
Minuti di sosta a ogni consegna (consegna, firma, ecc.). Aggiunto dopo ogni delivery in `calcTripTimes` e contribuisce al `totalTime` del giro.

---

## Penalità nuovo giro (`newTripPenalty`)
*Presente in `DEFAULT_CFG` ma non esposto nel cost model attuale come moltiplicatore diretto.* Storicamente penalizzava l'apertura di un nuovo giro vs. l'inserimento in uno esistente. Attualmente il tiebreaker per i nuovi giri è un piccolo offset basato su `rider.trips.length * 0.001`.

---

## Max consegne/giro (`maxDeliveriesPerTrip`)
Limite duro sul numero di fermate in un giro. Verificato sia in `isTripValid` che prima di tentare l'inserimento. Abbassarlo forza giri più brevi con meno destinazioni.

---

## Tolleranza distanza (min/km) (`distToleranceFactor`)
Aumenta il ritardo tollerato per consegne lontane. Formula:

```
lateToleranceForDelivery = min(lateToleranceMin + distToleranceFactor × distKm, tMaxMin)
```

Con `distToleranceFactor = 0` tutti hanno la stessa tolleranza. Con valori alti, una consegna a 3 km può tollerare minuti aggiuntivi rispetto a una vicina.

---

## Durata slot (min) (`slotDurationMin`)
Ampiezza temporale di ogni slot (es. 30 min = slot alle 19:00, 19:30, 20:00…). Usato per generare la griglia degli slot nell'UI e per raggruppare le consegne. Consegne dello stesso slot possono stare nello stesso giro.

---

## Peso deviazione (`deviationWeight`)
Quanto penalizzare la deviazione dall'orario di slot nelle funzioni di costo. La deviazione di un giro è la somma degli `|arrivalTime - slot|` per ogni consegna. Un valore alto spinge l'algoritmo a preferire arrivi puntuali anche a costo di giri meno efficienti in km.

---

## Elasticità spaziale (`spatialElasticity`)
Controlla quanto un giro può deviare geometricamente dalla linea pizzeria → consegna più lontana.

**Meccanismo** (in `isTripValid`): per ogni consegna non-farthest nel giro, calcola la deviazione triangolare:
```
deviazioneReale [km] = dist(pizzeria, d) + dist(d, farthest) - dist(pizzeria, farthest)
```
Se `deviazioneReale > spatialElasticity / maxDist` il giro è rifiutato.

Tutte le distanze sono in **km** (da `haversineKm`). Per rendere il confronto dimensionalmente consistente — `km > X / km` — il parametro `spatialElasticity` ha unità di **km²**, anche se di fatto è un numero di tuning empirico.

Esempio concreto con `spatialElasticity = 6.0`:
- consegna farthest a 2 km → soglia = 6/2 = **3 km** di deviazione permessa
- consegna farthest a 0.5 km → soglia = 6/0.5 = **12 km** di deviazione permessa

**Effetto pratico**:
- **Basso** (es. 1–2): solo consegne quasi nella stessa direzione possono stare nello stesso giro. Giri molto diretti.
- **Alto** (es. 10–20): anche consegne in direzioni diverse vengono raggruppate. Più efficiente in km ma geometricamente "storto".
- Il denominatore `maxDist` fa sì che giri con consegne lontane siano più rigidi: la stessa deviazione assoluta è più grave se la consegna più lontana è a 5 km rispetto a 0.5 km.
