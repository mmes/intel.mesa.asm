Native code for unnamed compute shader  (src_hash 0x0000000000000001) (blake3 0000000000000000000000000000000000000000000000000000000000000000)
SIMD16 shader: 16 instructions. 1 loops. 1100 cycles. 0:0 spills:fills, 3 sends, scheduled with mode none. Promoted 0 constants. Compacted 272 to 240 bytes (12%)

// 40 cycles
(W)     mov (16)                  r10           r0.1<0>                           {Compacted}
        mov (16)                  r12           r1:uw
        mov (16)                  r14           0x00000000                        {Compacted}
(W)     shl (16)                  r10:d         r10<0>:d          0x00000004      {I@3}
        add (16)                  r10:d         r10<0>:d          r12:d           {Compacted,I@1}

L0: // 120 cycles
        cmp (16)       (ge)f0.0   null          r14               r2<0>           {I@2}
(f0.0)  break (16)                            jip:L1              uip:L1

// 900 cycles
        shl (16)                  r16:d         r14:d             0x00000002      {$1.src}
        add (16)                  r14:d         r14:d             1:d
        add (16)                  r16:d         r16:d             r10:d           {Compacted,I@2}
        send.ugm (16)             r18     r16    null:0  0x00000000  0x62100500   {I@1,$0}  // wr:1+0, rd:1; load.ugm.d32.a32.bti[0]
        mul (16)                  r20:f         r18:f             0x40000000:f    {$0.dst}
(W)     sync.nop (1)                            null                              {F@1}
        send.ugm (16)             null    r16    r20:1   0x01000040  0x62000504   {$1}  // wr:1+1, rd:0; store.ugm.d32.a32.bti[1]

L1:
        while (16)                            L0

// 16 cycles
(W)     mov (16)                  r127          r0                                {Compacted}
(W)     send.gtwy (16)            null    r127   null:0  0x00000000  0x02000000   {EOT,I@1}  // wr:1+0, rd:0; open (16)
