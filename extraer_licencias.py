"""
Script para extraer todas las wallets que compraron licencias WLD y SUSHI
del contrato HachiMinerCore.

El RPC público de World Chain limita eth_getLogs a 100 bloques por consulta,
así que este script pagina automáticamente en chunks de 100 bloques.
"""

from web3 import Web3
import csv
import time

RPC = "https://worldchain-mainnet.g.alchemy.com/public"
CORE_ADDRESS = "0xE1892183A27389c6a4CACc091F62F9412B7EA6b9"
FROM_BLOCK = 31415082
CHUNK_SIZE = 100

WLD_TYPES = ["Básica", "Estándar", "Premium", "Elite"]
SUSHI_TYPES = ["Básica", "Estándar", "Premium", "Elite"]

ABI = [
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "user", "type": "address"},
            {"indexed": False, "name": "id", "type": "uint256"},
            {"indexed": False, "name": "hachiTotal", "type": "uint256"},
            {"indexed": False, "name": "licType", "type": "uint8"},
            {"indexed": False, "name": "wldPrice", "type": "uint256"},
        ],
        "name": "WLDLicBought",
        "type": "event",
    },
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "user", "type": "address"},
            {"indexed": False, "name": "id", "type": "uint256"},
            {"indexed": False, "name": "sushiTotal", "type": "uint256"},
            {"indexed": False, "name": "licType", "type": "uint8"},
            {"indexed": False, "name": "hachiPrice", "type": "uint256"},
        ],
        "name": "SushiLicBought",
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
    contract = w3.eth.contract(address=Web3.to_checksum_address(CORE_ADDRESS), abi=ABI)
    latest = w3.eth.block_number
    total_blocks = latest - FROM_BLOCK
    print(f"Consultando desde el bloque {FROM_BLOCK} hasta {latest} ({total_blocks} bloques, en chunks de {CHUNK_SIZE})...")
    print("Esto puede tardar varios minutos. Por favor esperá...\n")

    rows = []

    print("Buscando compras WLD...")
    wld_events = get_logs_paginated(contract.events.WLDLicBought, FROM_BLOCK, latest, label="WLD")
    for ev in wld_events:
        rows.append({
            "wallet": ev["args"]["user"],
            "tipo_token": "WLD",
            "licencia": WLD_TYPES[ev["args"]["licType"]],
            "id": ev["args"]["id"],
            "monto_pagado_wld": ev["args"]["wldPrice"] / 1e18,
            "hachi_total": ev["args"]["hachiTotal"] / 1e18,
            "tx_hash": ev["transactionHash"].hex(),
            "bloque": ev["blockNumber"],
        })

    print("\nBuscando compras SUSHI...")
    sushi_events = get_logs_paginated(contract.events.SushiLicBought, FROM_BLOCK, latest, label="SUSHI")
    for ev in sushi_events:
        rows.append({
            "wallet": ev["args"]["user"],
            "tipo_token": "SUSHI",
            "licencia": SUSHI_TYPES[ev["args"]["licType"]],
            "id": ev["args"]["id"],
            "monto_pagado_hachi": ev["args"]["hachiPrice"] / 1e18,
            "sushi_total": ev["args"]["sushiTotal"] / 1e18,
            "tx_hash": ev["transactionHash"].hex(),
            "bloque": ev["blockNumber"],
        })

    rows.sort(key=lambda r: r["bloque"])

    if not rows:
        print("\nNo se encontraron compras.")
        return

    fieldnames = sorted(set(k for r in rows for k in r.keys()))
    with open("licencias_compradas.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n{len(rows)} compras encontradas. Guardado en licencias_compradas.csv\n")
    for r in rows:
        print(r)

    print("\n--- Resumen por wallet ---")
    by_wallet = {}
    for r in rows:
        by_wallet.setdefault(r["wallet"], []).append(r)
    for wallet, compras in by_wallet.items():
        print(f"{wallet}: {len(compras)} compra(s)")
        for c in compras:
            print(f"   - {c['tipo_token']} {c['licencia']} (id={c['id']})")


if __name__ == "__main__":
    main()
