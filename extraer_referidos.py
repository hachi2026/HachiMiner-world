"""
Script para extraer todos los registros de referidos (Registered + ReferralBonus)
del contrato ReferralManager nuevo.
"""

from web3 import Web3
import csv
import time

RPC = "https://worldchain-mainnet.g.alchemy.com/public"
REFERRAL_ADDRESS = "0xeD93898021C07797797c783Dd5cd096e1C8644d5"
FROM_BLOCK = 31576851
CHUNK_SIZE = 100

ABI = [
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "user", "type": "address"},
            {"indexed": True, "name": "referrer", "type": "address"},
        ],
        "name": "Registered",
        "type": "event",
    },
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "referrer", "type": "address"},
            {"indexed": True, "name": "referee", "type": "address"},
            {"indexed": False, "name": "hachiToRef", "type": "uint256"},
            {"indexed": False, "name": "hachiToNew", "type": "uint256"},
        ],
        "name": "ReferralBonus",
        "type": "event",
    },
]


def get_logs_paginated(event, from_block, to_block, chunk_size=CHUNK_SIZE, label=""):
    all_logs = []
    current = from_block
    total_chunks = (to_block - from_block) // chunk_size + 1
    chunk_num = 0
    while current <= to_block:
        chunk_num += 1
        end = min(current + chunk_size - 1, to_block)
        for attempt in range(3):
            try:
                logs = event.get_logs(from_block=current, to_block=end)
                all_logs.extend(logs)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  [{label}] Falló el chunk {current}-{end} tras 3 intentos: {e}")
                else:
                    time.sleep(1)
        if chunk_num % 50 == 0:
            print(f"  [{label}] Progreso: chunk {chunk_num}/{total_chunks} (bloque {end})")
        current = end + 1
        time.sleep(0.05)
    return all_logs


def main():
    w3 = Web3(Web3.HTTPProvider(RPC))
    contract = w3.eth.contract(address=Web3.to_checksum_address(REFERRAL_ADDRESS), abi=ABI)
    latest = w3.eth.block_number
    print(f"Consultando desde el bloque {FROM_BLOCK} hasta {latest}...")
    print("Esto puede tardar varios minutos. Por favor esperá...\n")

    print("Buscando registros (Registered)...")
    registered_events = get_logs_paginated(contract.events.Registered, FROM_BLOCK, latest, label="Registered")

    print("\nBuscando bonos pagados (ReferralBonus)...")
    bonus_events = get_logs_paginated(contract.events.ReferralBonus, FROM_BLOCK, latest, label="ReferralBonus")

    bonus_map = {}
    for ev in bonus_events:
        key = (ev["args"]["referrer"], ev["args"]["referee"])
        bonus_map[key] = {
            "hachiToRef": ev["args"]["hachiToRef"] / 1e18,
            "hachiToNew": ev["args"]["hachiToNew"] / 1e18,
        }

    rows = []
    for ev in registered_events:
        user = ev["args"]["user"]
        referrer = ev["args"]["referrer"]
        bonus = bonus_map.get((referrer, user))
        rows.append({
            "nuevo_usuario": user,
            "referidor": referrer,
            "bono_pagado": "SI" if bonus else "NO (pool sin fondos en ese momento)",
            "hachi_a_referidor": bonus["hachiToRef"] if bonus else 0,
            "hachi_a_nuevo": bonus["hachiToNew"] if bonus else 0,
            "tx_hash": ev["transactionHash"].hex(),
            "bloque": ev["blockNumber"],
        })

    rows.sort(key=lambda r: r["bloque"])

    if not rows:
        print("\nNo se encontraron registros de referidos todavía.")
        return

    fieldnames = sorted(set(k for r in rows for k in r.keys()))
    with open("referidos.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n{len(rows)} registros encontrados. Guardado en referidos.csv\n")
    for r in rows:
        print(r)

    total_pagado = sum(r["hachi_a_referidor"] + r["hachi_a_nuevo"] for r in rows)
    print(f"\nTotal HACHI pagado en bonos de referidos: {total_pagado:,.0f}")


if __name__ == "__main__":
    main()
