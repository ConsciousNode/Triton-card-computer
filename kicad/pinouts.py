# pinouts.py: package pin numbers for the card computer's parts (Kehai Interim, 2026-11-22). MIT.
# Each entry: footprint (KiCad library:name), pins {our netlist pin name: package pin number}, power {VCC: [...], GND: [...]}
# and the source of the numbering. STATUS: "jedec" = the standard 74-series pinout, from memory, shared by TI and Nexperia
# for these functions; "derived" = assembled from more than one datasheet excerpt. NOTHING here is checked pin by pin
# against the vendor drawing yet: that check is a gate before any board is fabricated (KICAD.md).
TSSOP14 = 'Package_SO:TSSOP-14_4.4x5mm_P0.65mm'
TSSOP16 = 'Package_SO:TSSOP-16_4.4x5mm_P0.65mm'
TSSOP20 = 'Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm'
TSOP44 = 'Package_SO:TSOP-II-44_10.16x18.41mm_P0.8mm'

def quad_gate():   # '08, '32, '86: 1A 1B 1Y 2A 2B 2Y GND 3Y 3A 3B 4Y 4A 4B VCC
    return {'1A': 1, '1B': 2, '1Y': 3, '2A': 4, '2B': 5, '2Y': 6, '3Y': 8, '3A': 9, '3B': 10, '4Y': 11, '4A': 12, '4B': 13}
def hex_inv():     # '04, '07: 1A 1Y 2A 2Y 3A 3Y GND 4Y 4A 5Y 5A 6Y 6A VCC
    return {'1A': 1, '1Y': 2, '2A': 3, '2Y': 4, '3A': 5, '3Y': 6, '4Y': 8, '4A': 9, '5Y': 10, '5A': 11, '6Y': 12, '6A': 13}

PARTS = {
  'LVC08': dict(fp=TSSOP14, pins=quad_gate(), power={'VCC': [14], 'GND': [7]}, status='jedec'),
  'LVC32': dict(fp=TSSOP14, pins=quad_gate(), power={'VCC': [14], 'GND': [7]}, status='jedec'),
  'LVC86': dict(fp=TSSOP14, pins=quad_gate(), power={'VCC': [14], 'GND': [7]}, status='jedec'),
  'LVC04': dict(fp=TSSOP14, pins=hex_inv(), power={'VCC': [14], 'GND': [7]}, status='jedec'),
  'LVC07': dict(fp=TSSOP14, pins=hex_inv(), power={'VCC': [14], 'GND': [7]}, status='jedec'),
  # '245: DIR A1..A8 GND B8..B1 /OE VCC
  'LVC245': dict(fp=TSSOP20, pins={'DIR': 1, **{f'A{i}': 1 + i for i in range(1, 9)}, **{f'B{i}': 19 - i for i in range(1, 9)}, '/OE': 19},
                 power={'VCC': [20], 'GND': [10]}, status='jedec'),
  # '574: /OE D1..D8 GND CLK Q8..Q1 VCC
  'LVC574': dict(fp=TSSOP20, pins={'/OE': 1, **{f'D{i}': 1 + i for i in range(1, 9)}, 'CLK': 11, **{f'Q{i}': 20 - i for i in range(1, 9)}},
                 power={'VCC': [20], 'GND': [10]}, status='jedec'),
  # IS61WV5128EDBLL, 44-pin TSOP-II: left NC NC A0..A4 /CE IO0 IO1 VDD GND IO2 IO3 /WE A5..A9 NC NC; right (23 up to 44)
  # NC NC NC A10..A14 IO4 IO5 VDD GND IO6 IO7 /OE A15..A18 NC NC NC (36-pin SOJ order padded; ISSI 61WV5128/61C5128AL)
  'IS61WV5128': dict(fp=TSOP44, pins={'A0': 3, 'A1': 4, 'A2': 5, 'A3': 6, 'A4': 7, '/CE': 8, 'IO0': 9, 'IO1': 10, 'IO2': 13, 'IO3': 14,
                 '/WE': 15, 'A5': 16, 'A6': 17, 'A7': 18, 'A8': 19, 'A9': 20, 'A10': 26, 'A11': 27, 'A12': 28, 'A13': 29, 'A14': 30,
                 'IO4': 31, 'IO5': 32, 'IO6': 35, 'IO7': 36, '/OE': 37, 'A15': 38, 'A16': 39, 'A17': 40, 'A18': 41},
                 power={'VCC': [11, 33], 'GND': [12, 34]}, status='derived'),
  # bussed resistor network, 9-pin SIP: pin 1 common, pins 2..9 the resistors P1..P8 (pull-ups: common to VCC)
  'RPACK8': dict(fp='Resistor_THT:R_Array_SIP9', pins={f'P{i}': i + 1 for i in range(1, 9)}, power={'VCC': [1]}, status='jedec'),
  'RPACK8G': dict(fp='Resistor_THT:R_Array_SIP9', pins={f'P{i}': i + 1 for i in range(1, 9)}, power={'GND': [1]}, status='jedec'),
}

# ---- 2026-11-22, the other five cards ----
TSSOP56 = 'Package_SO:TSSOP-56_6.1x14mm_P0.5mm'
TSOP48 = 'Package_SO:TSOP-I-48_18.4x12mm_P0.5mm'
SOT235 = 'Package_TO_SOT_SMD:SOT-23-5'
# 74ALVCH16823 (TI SCES038 terminal list; Nexperia 74ALVCH16823 pin table agrees): our 1D0..1D8 = the datasheet's 1D1..1D9
_a823_l = ['1/CLR', '1/OE', '1Q0', 'G', '1Q1', '1Q2', 'V', '1Q3', '1Q4', '1Q5', 'G', '1Q6', '1Q7', '1Q8', '2Q0', '2Q1', '2Q2', 'G', '2Q3', '2Q4',
           '2Q5', 'V', '2Q6', '2Q7', 'G', '2Q8', '2/OE', '2/CLR']
_a823_r = ['1CLK', '1/CLKEN', '1D0', 'G', '1D1', '1D2', 'V', '1D3', '1D4', '1D5', 'G', '1D6', '1D7', '1D8', '2D0', '2D1', '2D2', 'G', '2D3', '2D4',
           '2D5', 'V', '2D6', '2D7', 'G', '2D8', '2/CLKEN', '2CLK']        # pins 56 down to 29
def _pk(left, right, n):   # left = pins 1..n/2, right = pins n down to n/2+1; 'G'/'V' are power, None is NC
    pins, pw = {}, {'VCC': [], 'GND': []}
    for i, s in enumerate(left): k = i + 1; (pw['GND'].append(k) if s == 'G' else pw['VCC'].append(k) if s == 'V' else pins.__setitem__(s, k) if s else None)
    for i, s in enumerate(right): k = n - i; (pw['GND'].append(k) if s == 'G' else pw['VCC'].append(k) if s == 'V' else pins.__setitem__(s, k) if s else None)
    return pins, pw
_p, _w = _pk(_a823_l, _a823_r, 56); PARTS['ALVCH16823'] = dict(fp=TSSOP56, pins=_p, power=_w, status='ti-datasheet+nexperia')
# IS61WV51216 (ISSI 61WV51216 44-pin TSOP-II): x16
_p, _w = _pk(['A0', 'A1', 'A2', 'A3', 'A4', '/CE', 'IO0', 'IO1', 'IO2', 'IO3', 'V', 'G', 'IO4', 'IO5', 'IO6', 'IO7', '/WE', 'A5', 'A6', 'A7', 'A8', 'A9'],
             ['A17', 'A16', 'A15', '/OE', '/UB', '/LB', 'IO15', 'IO14', 'IO13', 'IO12', 'G', 'V', 'IO11', 'IO10', 'IO9', 'IO8', 'A18', 'A14', 'A13', 'A12', 'A11', 'A10'], 44)
PARTS['IS61WV51216'] = dict(fp=TSOP44, pins=_p, power=_w, status='issi-datasheet')
# IS61WV20488 (ISSI 61WV20488 44-pin TSOP-II): 2M x 8
_p, _w = _pk([None, None, 'A0', 'A1', 'A2', 'A3', 'A4', '/CE', 'IO0', 'IO1', 'V', 'G', 'IO2', 'IO3', '/WE', 'A5', 'A6', 'A7', 'A8', 'A9', None, None],
             [None, None, 'A20', 'A18', 'A17', 'A16', 'A15', '/OE', 'IO7', 'IO6', 'G', 'V', 'IO5', 'IO4', 'A14', 'A13', 'A12', 'A11', 'A10', 'A19', None, None], 44)
PARTS['IS61WV20488'] = dict(fp=TSOP44, pins=_p, power=_w, status='issi-datasheet')
# IS61WV204816 (2M x 16, 48-pin TSOP-I): PROVISIONAL reconstruction from scrambled excerpts; must be redone from the drawing
_p, _w = _pk(['A4', 'A3', 'A2', 'A1', 'A0', None, '/CE', 'IO0', 'IO1', 'IO2', 'IO3', 'V', 'G', 'IO4', 'IO5', 'IO6', 'IO7', '/WE', 'A19', 'A18', 'A17', 'A16', 'A15', 'A14'],
             ['A5', 'A6', 'A7', 'A8', 'A20', '/OE', '/UB', '/LB', 'IO15', 'IO14', 'IO13', 'IO12', 'V', 'G', 'IO11', 'IO10', 'IO9', 'IO8', 'A9', 'A10', 'A11', 'A12', 'A13', None], 48)
PARTS['IS61WV204816'] = dict(fp=TSOP48, pins=_p, power=_w, status='PROVISIONAL')
# TI bus switches (pin tables in SCDS039, SCDS034, SCDS040)
PARTS['CBTLV3253'] = dict(fp=TSSOP16, pins={'1/OE': 1, 'S1': 2, '1B4': 3, '1B3': 4, '1B2': 5, '1B1': 6, '1A': 7, '2A': 9, '2B1': 10, '2B2': 11, '2B3': 12, '2B4': 13, 'S0': 14, '2/OE': 15},
                          power={'VCC': [16], 'GND': [8]}, status='ti-datasheet')
PARTS['CBTLV3245'] = dict(fp=TSSOP20, pins={**{f'A{i}': 1 + i for i in range(1, 9)}, **{f'B{i}': 19 - i for i in range(1, 9)}, '/OE': 19},
                          power={'VCC': [20], 'GND': [10]}, status='ti-datasheet')
PARTS['CBTLV3257'] = dict(fp=TSSOP16, pins={'S': 1, '1B1': 2, '1B2': 3, '1A': 4, '2B1': 5, '2B2': 6, '2A': 7, '3A': 9, '3B2': 10, '3B1': 11, '4A': 12, '4B2': 13, '4B1': 14, '/OE': 15},
                          power={'VCC': [16], 'GND': [8]}, status='ti-datasheet')
PARTS['LV8154'] = dict(fp=TSSOP20, pins={'CLKA': 1, 'CLKB': 2, 'GAL': 3, 'GAU': 4, 'GBL': 5, 'GBU': 6, 'RCLK': 7, 'RCOA': 8, 'CLKBEN': 9, 'CCLR': 11,
                          **{f'Y{i}': 19 - i for i in range(8)}}, power={'VCC': [20], 'GND': [10]}, status='ti-datasheet')
# standard 74-series (JEDEC, from memory: gate before fab)
PARTS['LVC157'] = dict(fp=TSSOP16, pins={'S': 1, '1I0': 2, '1I1': 3, '1Y': 4, '2I0': 5, '2I1': 6, '2Y': 7, '3Y': 9, '3I1': 10, '3I0': 11, '4Y': 12, '4I1': 13, '4I0': 14, '/E': 15},
                       power={'VCC': [16], 'GND': [8]}, status='jedec')
PARTS['LVC153'] = dict(fp=TSSOP16, pins={'1/E': 1, 'S1': 2, '1I3': 3, '1I2': 4, '1I1': 5, '1I0': 6, '1Y': 7, '2Y': 9, '2I0': 10, '2I1': 11, '2I2': 12, '2I3': 13, 'S0': 14, '2/E': 15},
                       power={'VCC': [16], 'GND': [8]}, status='jedec')
PARTS['LVC161'] = dict(fp=TSSOP16, pins={'MR_N': 1, 'CP': 2, 'CLK': 2, 'D0': 3, 'D1': 4, 'D2': 5, 'D3': 6, 'CEP': 7, 'PE_N': 9, 'CET': 10, 'Q3': 11, 'Q2': 12, 'Q1': 13, 'Q0': 14, 'TC': 15},
                       power={'VCC': [16], 'GND': [8]}, status='jedec')
PARTS['LVC74'] = dict(fp=TSSOP14, pins={'1/CLR': 1, '1D': 2, '1CLK': 3, '1/PRE': 4, '1Q': 5, '1/Q': 6, '2/Q': 8, '2Q': 9, '2/PRE': 10, '2CLK': 11, '2D': 12, '2/CLR': 13},
                      power={'VCC': [14], 'GND': [7]}, status='jedec')
PARTS['LVC11'] = dict(fp=TSSOP14, pins={'1A': 1, '1B': 2, '2A': 3, '2B': 4, '2C': 5, '2Y': 6, '3Y': 8, '3A': 9, '3B': 10, '3C': 11, '1Y': 12, '1C': 13},
                      power={'VCC': [14], 'GND': [7]}, status='jedec')
PARTS['LVC244'] = dict(fp=TSSOP20, pins={'1/OE': 1, '1A1': 2, '2Y4': 3, '1A2': 4, '2Y3': 5, '1A3': 6, '2Y2': 7, '1A4': 8, '2Y1': 9, '2A1': 11, '1Y4': 12, '2A2': 13,
                       '1Y3': 14, '2A3': 15, '1Y2': 16, '2A4': 17, '1Y1': 18, '2/OE': 19}, power={'VCC': [20], 'GND': [10]}, status='jedec')
PARTS['LVC125'] = dict(fp=TSSOP14, pins={'1/OE': 1, '1A': 2, '1Y': 3, '2/OE': 4, '2A': 5, '2Y': 6, '3Y': 8, '3A': 9, '3/OE': 10, '4Y': 11, '4A': 12, '4/OE': 13},
                       power={'VCC': [14], 'GND': [7]}, status='jedec')
PARTS['LVC138'] = dict(fp=TSSOP16, pins={'A': 1, 'B': 2, 'C': 3, '/G2A': 4, '/G2B': 5, 'G1': 6, '/Y7': 7, '/Y6': 9, '/Y5': 10, '/Y4': 11, '/Y3': 12, '/Y2': 13, '/Y1': 14, '/Y0': 15},
                       power={'VCC': [16], 'GND': [8]}, status='jedec')
PARTS['LVC165'] = dict(fp=TSSOP16, pins={'SH/LD': 1, 'CLK': 2, 'E': 3, 'F': 4, 'G': 5, 'H': 6, 'QH': 9, 'SER': 10, 'A': 11, 'B': 12, 'C': 13, 'D': 14, 'CLKINH': 15},
                       power={'VCC': [16], 'GND': [8]}, status='jedec')
PARTS['LV164'] = dict(fp=TSSOP14, pins={'A': 1, 'B': 2, 'Q0': 3, 'Q1': 4, 'Q2': 5, 'Q3': 6, 'CLK': 8, '/CLR': 9, 'Q4': 10, 'Q5': 11, 'Q6': 12, 'Q7': 13},
                      power={'VCC': [14], 'GND': [7]}, status='jedec')
PARTS['CD4060'] = dict(fp=TSSOP16, pins={'Q14': 3, 'PHI1': 11, 'MR': 12}, power={'VCC': [16], 'GND': [8]}, status='jedec')
PARTS['LVC1G07'] = dict(fp=SOT235, pins={'A': 2, 'Y': 4}, power={'VCC': [5], 'GND': [3]}, status='jedec')
