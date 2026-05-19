/* References imported memory + an external function so we can see
 * how SIDE_MODULE encodes them. */
extern int sh4_read32(int addr);
extern void sh4_ifb(int opc, int pc);
int run(int ctx, int ram_base) {
    int v = *(int*)(ram_base + 0x100);   /* uses memory */
    sh4_ifb(0x1234, ctx);                /* uses imported function */
    return v + sh4_read32(ram_base);
}
