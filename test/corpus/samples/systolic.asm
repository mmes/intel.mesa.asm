Native code for unnamed compute shader  (src_hash 0x0000000000000002) (blake3 0000000000000000000000000000000000000000000000000000000000000000)
SIMD16 shader: 26 instructions. 0 loops. 2400 cycles. 0:0 spills:fills, 3 sends, scheduled with mode none. Promoted 0 constants. Compacted 448 to 424 bytes (5%)

// 300 cycles
(W)     and (1)                   r3.2          r0.2<0>           0x000000ff
(W)     mov (16)                  r5:f          0x00000000:f                      {Compacted}
(W)     mov (8)                   r6:uw         0x76543210:v
(W)     add (8)                   r6.8:uw       r6:uw             8:uw            {I@1}
        mov (32)                  r8            r6:uw                             {I@1}
        add3 (32)                 r10:d         r8:d              r8:d              r3.2<0>:d {I@1}
        mov (16)                  r12:f         r10:d                             {I@1}
        mad (16)                  r13:f         r5:f              r12:f             r12:f {F@1}
        math.exp (16)             r14:f         r13:f             null            {F@1}
        bfn.(a & b | ~a & c) (16) r15           r10               r8                r3.2<0> {M@1}
(W&~f0.0) sel (16)                r16:f         r14:f             r13:f
        cmp (16)       (gt)f0.0   null          r16:f             0x3f800000:f    {F@1}
(f0.0)  if (16)                               jip:L0              uip:L1
        mov (16)                  r17:f         r16:f

L0:
        else (16)                             jip:L1              uip:L1
        mov (16)                  r17:f         -r16:f

L1:
        endif (16)                            L1

// 2000 cycles
(W)     mov (1)                   r20:uq        0x0000000000001000:uq
(W)     send.ugm (1)              r24     r20    null:0  0x00000000  0x0210D580   {L@1,$2}  // wr:1+0, rd:1; load.ugm.d32x16t.a64
(W)     mov (16)                  r32<2>:hf     r24:f                             {$2.dst}
(W)     mov (16)                  r48:f         0x00000000:f                      {Compacted}
(W)     dpas.8x8 (16)             r40:f         r48:f             r32:hf            r56:hf {F@1,$3}
(W)     mov (1)                   s0:uq         0x000000002b2a2928:uq             {$3.dst}
(W)     sync.nop (1)                            null                              {S@1}
        send.slm (16)             null    r[s0.0] null:0 0x00000000  0x08000504   {$4}  // wr:4+0, rd:0; store.slm.d32.a32
(W)     sync.allwr (1)                          null

// 100 cycles
(W)     mov (16)                  r127          r0                                {Compacted,$4.src}
(W)     send.gtwy (16)            null    r127   null:0  0x00000000  0x02000000   {EOT,I@1}  // wr:1+0, rd:0; open (16)
